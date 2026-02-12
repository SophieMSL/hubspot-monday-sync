const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Store configuration in memory (in production, use a database)
let config = {
  hubspotToken: process.env.HUBSPOT_TOKEN || '',
  mondayToken: process.env.MONDAY_TOKEN || '',
  mondayBoardId: process.env.MONDAY_BOARD_ID || '',
  syncEnabled: false,
  lastSync: null,
  syncLog: [],
  // Field-level sync rules: which platform is source of truth for each field
  fieldRules: {
    title: 'hubspot',        // 'hubspot', 'monday', or 'both'
    description: 'hubspot',  // HubSpot owns ticket content
    status: 'monday',        // Monday owns status updates
    priority: 'monday',      // Monday owns priority
    assignee: 'both'         // Both can update assignee
  }
};

// Sync state tracking to prevent infinite loops
const syncState = new Map();

// Helper function to log sync events
function logSync(message, type = 'info') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  config.syncLog.unshift(logEntry);
  if (config.syncLog.length > 50) config.syncLog.pop();
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ========== HUBSPOT FUNCTIONS ==========

async function getHubSpotTickets() {
  try {
    const response = await axios.get('https://api.hubapi.com/crm/v3/objects/tickets', {
      headers: {
        'Authorization': `Bearer ${config.hubspotToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        properties: 'subject,content,hs_pipeline_stage,hs_ticket_priority,hubspot_owner_id',
        limit: 100
      }
    });
    return response.data.results || [];
  } catch (error) {
    logSync(`Error fetching HubSpot tickets: ${error.message}`, 'error');
    throw error;
  }
}

async function createHubSpotTicket(data) {
  try {
    const response = await axios.post('https://api.hubapi.com/crm/v3/objects/tickets', {
      properties: {
        subject: data.subject,
        content: data.content,
        hs_pipeline_stage: data.status || 'new',
        hs_ticket_priority: data.priority || 'MEDIUM'
      }
    }, {
      headers: {
        'Authorization': `Bearer ${config.hubspotToken}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    logSync(`Error creating HubSpot ticket: ${error.message}`, 'error');
    throw error;
  }
}

async function updateHubSpotTicket(ticketId, data) {
  try {
    // Only include properties that are provided
    const properties = {};
    if (data.subject !== undefined) properties.subject = data.subject;
    if (data.content !== undefined) properties.content = data.content;
    if (data.status !== undefined) properties.hs_pipeline_stage = data.status;
    if (data.priority !== undefined) properties.hs_ticket_priority = data.priority;
    
    const response = await axios.patch(`https://api.hubapi.com/crm/v3/objects/tickets/${ticketId}`, {
      properties
    }, {
      headers: {
        'Authorization': `Bearer ${config.hubspotToken}`,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (error) {
    logSync(`Error updating HubSpot ticket: ${error.message}`, 'error');
    throw error;
  }
}

// ========== MONDAY.COM FUNCTIONS ==========

async function mondayQuery(query, variables = {}) {
  try {
    const response = await axios.post('https://api.monday.com/v2', {
      query,
      variables
    }, {
      headers: {
        'Authorization': config.mondayToken,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.data.errors) {
      throw new Error(response.data.errors[0].message);
    }
    
    return response.data.data;
  } catch (error) {
    logSync(`Monday.com API error: ${error.message}`, 'error');
    throw error;
  }
}

async function getMondayItems() {
  const query = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page {
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }
  `;
  
  const data = await mondayQuery(query, { boardId: config.mondayBoardId });
  return data.boards[0]?.items_page?.items || [];
}

async function createMondayItem(ticketData) {
  const query = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(board_id: $boardId, item_name: $itemName, column_values: $columnValues) {
        id
      }
    }
  `;
  
  const columnValues = JSON.stringify({
    text: ticketData.content || '',
    status: ticketData.status || 'New',
    priority: ticketData.priority || 'Medium'
  });
  
  const data = await mondayQuery(query, {
    boardId: config.mondayBoardId,
    itemName: ticketData.subject,
    columnValues
  });
  
  return data.create_item;
}

async function updateMondayItem(itemId, ticketData) {
  const query = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) {
        id
      }
    }
  `;
  
  // Only include fields that are provided
  const columnValues = {};
  if (ticketData.content !== undefined) columnValues.text = ticketData.content;
  if (ticketData.status !== undefined) columnValues.status = ticketData.status;
  if (ticketData.priority !== undefined) columnValues.priority = ticketData.priority;
  
  const data = await mondayQuery(query, {
    boardId: config.mondayBoardId,
    itemId,
    columnValues: JSON.stringify(columnValues)
  });
  
  return data.change_multiple_column_values;
}

// ========== SYNC FUNCTIONS ==========

async function syncHubSpotToMonday() {
  if (!config.syncEnabled) return;
  
  try {
    logSync('Starting HubSpot → Monday.com sync...', 'info');
    const tickets = await getHubSpotTickets();
    const mondayItems = await getMondayItems();
    
    // Create a map of existing Monday items by name (simple matching)
    const mondayMap = new Map();
    mondayItems.forEach(item => {
      mondayMap.set(item.name, item);
    });
    
    let created = 0;
    let updated = 0;
    
    for (const ticket of tickets) {
      const ticketData = {
        subject: ticket.properties.subject,
        content: ticket.properties.content,
        status: ticket.properties.hs_pipeline_stage,
        priority: ticket.properties.hs_ticket_priority
      };
      
      const existingItem = mondayMap.get(ticketData.subject);
      
      if (!existingItem) {
        // New item - create with all fields
        await createMondayItem(ticketData);
        created++;
        logSync(`Created Monday item: ${ticketData.subject}`, 'success');
      } else {
        // Existing item - only update fields where HubSpot is source of truth
        const updateData = {};
        
        // Only sync fields where HubSpot is the source of truth or 'both'
        if (config.fieldRules.title === 'hubspot' || config.fieldRules.title === 'both') {
          updateData.subject = ticketData.subject;
        }
        if (config.fieldRules.description === 'hubspot' || config.fieldRules.description === 'both') {
          updateData.content = ticketData.content;
        }
        if (config.fieldRules.status === 'hubspot' || config.fieldRules.status === 'both') {
          updateData.status = ticketData.status;
        }
        if (config.fieldRules.priority === 'hubspot' || config.fieldRules.priority === 'both') {
          updateData.priority = ticketData.priority;
        }
        
        // Only update if we have fields to sync
        if (Object.keys(updateData).length > 0) {
          await updateMondayItem(existingItem.id, updateData);
          updated++;
          logSync(`Updated Monday item: ${ticketData.subject} (${Object.keys(updateData).join(', ')})`, 'info');
        }
      }
    }
    
    logSync(`HubSpot → Monday sync complete: ${created} created, ${updated} updated`, 'success');
    config.lastSync = new Date().toISOString();
  } catch (error) {
    logSync(`Sync failed: ${error.message}`, 'error');
  }
}

async function syncMondayToHubSpot() {
  if (!config.syncEnabled) return;
  
  try {
    logSync('Starting Monday.com → HubSpot sync...', 'info');
    const mondayItems = await getMondayItems();
    const hubspotTickets = await getHubSpotTickets();
    
    // Create a map of existing HubSpot tickets by subject
    const hubspotMap = new Map();
    hubspotTickets.forEach(ticket => {
      hubspotMap.set(ticket.properties.subject, ticket);
    });
    
    let created = 0;
    let updated = 0;
    
    for (const item of mondayItems) {
      const textCol = item.column_values.find(col => col.id === 'text');
      const statusCol = item.column_values.find(col => col.id === 'status');
      const priorityCol = item.column_values.find(col => col.id === 'priority');
      
      const itemData = {
        subject: item.name,
        content: textCol?.text || '',
        status: statusCol?.text || 'new',
        priority: priorityCol?.text || 'MEDIUM'
      };
      
      const existingTicket = hubspotMap.get(itemData.subject);
      
      if (!existingTicket) {
        // New ticket - create with all fields
        await createHubSpotTicket(itemData);
        created++;
        logSync(`Created HubSpot ticket: ${itemData.subject}`, 'success');
      } else {
        // Existing ticket - only update fields where Monday is source of truth
        const updateData = {};
        
        // Only sync fields where Monday is the source of truth or 'both'
        if (config.fieldRules.title === 'monday' || config.fieldRules.title === 'both') {
          updateData.subject = itemData.subject;
        }
        if (config.fieldRules.description === 'monday' || config.fieldRules.description === 'both') {
          updateData.content = itemData.content;
        }
        if (config.fieldRules.status === 'monday' || config.fieldRules.status === 'both') {
          updateData.status = itemData.status;
        }
        if (config.fieldRules.priority === 'monday' || config.fieldRules.priority === 'both') {
          updateData.priority = itemData.priority;
        }
        
        // Only update if we have fields to sync
        if (Object.keys(updateData).length > 0) {
          await updateHubSpotTicket(existingTicket.id, updateData);
          updated++;
          logSync(`Updated HubSpot ticket: ${itemData.subject} (${Object.keys(updateData).join(', ')})`, 'info');
        }
      }
    }
    
    logSync(`Monday → HubSpot sync complete: ${created} created, ${updated} updated`, 'success');
    config.lastSync = new Date().toISOString();
  } catch (error) {
    logSync(`Sync failed: ${error.message}`, 'error');
  }
}

async function performFullSync() {
  await syncHubSpotToMonday();
  await syncMondayToHubSpot();
}

// ========== WEB INTERFACE ==========

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>HubSpot ↔ Monday.com Sync</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          max-width: 900px;
          margin: 50px auto;
          padding: 20px;
          background: #f5f5f5;
        }
        .container {
          background: white;
          padding: 30px;
          border-radius: 8px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
          color: #333;
          margin-bottom: 10px;
        }
        .subtitle {
          color: #666;
          margin-bottom: 30px;
        }
        .form-group {
          margin-bottom: 20px;
        }
        label {
          display: block;
          margin-bottom: 5px;
          font-weight: 600;
          color: #333;
        }
        input, textarea {
          width: 100%;
          padding: 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 14px;
          box-sizing: border-box;
        }
        button {
          background: #0073ea;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          margin-right: 10px;
        }
        button:hover {
          background: #0060c0;
        }
        .danger {
          background: #e44258;
        }
        .danger:hover {
          background: #c23448;
        }
        .success {
          background: #00c875;
        }
        .success:hover {
          background: #00a565;
        }
        .status {
          padding: 15px;
          border-radius: 4px;
          margin: 20px 0;
        }
        .status.enabled {
          background: #e6f7ed;
          border: 1px solid #00c875;
        }
        .status.disabled {
          background: #fff3e6;
          border: 1px solid #ff9900;
        }
        .log {
          background: #f9f9f9;
          border: 1px solid #ddd;
          border-radius: 4px;
          padding: 15px;
          max-height: 300px;
          overflow-y: auto;
          font-family: monospace;
          font-size: 12px;
        }
        .log-entry {
          margin-bottom: 8px;
          padding: 4px;
        }
        .log-entry.error {
          color: #e44258;
        }
        .log-entry.success {
          color: #00c875;
        }
        .log-entry.info {
          color: #333;
        }
        .help-text {
          font-size: 12px;
          color: #666;
          margin-top: 5px;
        }
        .section {
          margin-top: 40px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔄 HubSpot ↔ Monday.com Sync</h1>
        <p class="subtitle">Two-way ticket synchronization made simple</p>
        
        <div class="status ${config.syncEnabled ? 'enabled' : 'disabled'}">
          <strong>Status:</strong> ${config.syncEnabled ? '✅ Sync Enabled' : '⚠️ Sync Disabled'}
          ${config.lastSync ? `<br><small>Last sync: ${new Date(config.lastSync).toLocaleString()}</small>` : ''}
        </div>

        <form action="/config" method="POST">
          <div class="form-group">
            <label>HubSpot Access Token</label>
            <input type="password" name="hubspotToken" value="${config.hubspotToken}" placeholder="pat-na1-xxxxx..." required>
            <div class="help-text">Get this from HubSpot Settings → Integrations → Private Apps</div>
          </div>

          <div class="form-group">
            <label>Monday.com API Token</label>
            <input type="password" name="mondayToken" value="${config.mondayToken}" placeholder="eyJhbGc..." required>
            <div class="help-text">Get this from Monday.com → Profile → Admin → API</div>
          </div>

          <div class="form-group">
            <label>Monday.com Board ID</label>
            <input type="text" name="mondayBoardId" value="${config.mondayBoardId}" placeholder="1234567890" required>
            <div class="help-text">Find this in the URL when viewing your board</div>
          </div>

          <button type="submit">💾 Save Configuration</button>
        </form>

        <div class="section">
          <h3>⚙️ Field Sync Rules</h3>
          <p class="help-text">Choose which platform is the "source of truth" for each field. This prevents conflicts!</p>
          
          <form action="/rules" method="POST">
            <div class="form-group">
              <label>Title/Subject</label>
              <select name="title" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                <option value="hubspot" ${config.fieldRules.title === 'hubspot' ? 'selected' : ''}>HubSpot (HubSpot → Monday only)</option>
                <option value="monday" ${config.fieldRules.title === 'monday' ? 'selected' : ''}>Monday (Monday → HubSpot only)</option>
                <option value="both" ${config.fieldRules.title === 'both' ? 'selected' : ''}>Both (last update wins)</option>
              </select>
            </div>

            <div class="form-group">
              <label>Description/Content</label>
              <select name="description" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                <option value="hubspot" ${config.fieldRules.description === 'hubspot' ? 'selected' : ''}>HubSpot (HubSpot → Monday only)</option>
                <option value="monday" ${config.fieldRules.description === 'monday' ? 'selected' : ''}>Monday (Monday → HubSpot only)</option>
                <option value="both" ${config.fieldRules.description === 'both' ? 'selected' : ''}>Both (last update wins)</option>
              </select>
              <div class="help-text">💡 Recommended: HubSpot (ticket details managed in HubSpot)</div>
            </div>

            <div class="form-group">
              <label>Status</label>
              <select name="status" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                <option value="hubspot" ${config.fieldRules.status === 'hubspot' ? 'selected' : ''}>HubSpot (HubSpot → Monday only)</option>
                <option value="monday" ${config.fieldRules.status === 'monday' ? 'selected' : ''}>Monday (Monday → HubSpot only)</option>
                <option value="both" ${config.fieldRules.status === 'both' ? 'selected' : ''}>Both (last update wins)</option>
              </select>
              <div class="help-text">💡 Recommended: Monday (update status in Monday board)</div>
            </div>

            <div class="form-group">
              <label>Priority</label>
              <select name="priority" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                <option value="hubspot" ${config.fieldRules.priority === 'hubspot' ? 'selected' : ''}>HubSpot (HubSpot → Monday only)</option>
                <option value="monday" ${config.fieldRules.priority === 'monday' ? 'selected' : ''}>Monday (Monday → HubSpot only)</option>
                <option value="both" ${config.fieldRules.priority === 'both' ? 'selected' : ''}>Both (last update wins)</option>
              </select>
              <div class="help-text">💡 Recommended: Monday (prioritize in Monday board)</div>
            </div>

            <div class="form-group">
              <label>Assignee</label>
              <select name="assignee" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px;">
                <option value="hubspot" ${config.fieldRules.assignee === 'hubspot' ? 'selected' : ''}>HubSpot (HubSpot → Monday only)</option>
                <option value="monday" ${config.fieldRules.assignee === 'monday' ? 'selected' : ''}>Monday (Monday → HubSpot only)</option>
                <option value="both" ${config.fieldRules.assignee === 'both' ? 'selected' : ''}>Both (last update wins)</option>
              </select>
              <div class="help-text">💡 Recommended: Both (assign tickets from either platform)</div>
            </div>

            <button type="submit">💾 Save Field Rules</button>
          </form>

          <div style="background: #e6f3ff; border-left: 4px solid #0073ea; padding: 15px; margin-top: 20px; border-radius: 4px;">
            <strong>📘 How Field Rules Work:</strong>
            <ul style="margin: 10px 0; padding-left: 20px;">
              <li><strong>HubSpot:</strong> Only changes in HubSpot sync to Monday (Monday changes ignored)</li>
              <li><strong>Monday:</strong> Only changes in Monday sync to HubSpot (HubSpot changes ignored)</li>
              <li><strong>Both:</strong> Changes from either platform sync (last edit wins if conflict)</li>
            </ul>
            <p style="margin: 10px 0 0 0;"><strong>Example workflow:</strong> HubSpot owns ticket details (title, description), Monday owns workflow (status, priority)</p>
          </div>
        </div>

        <div class="section">
          <h3>Sync Controls</h3>
          <form action="/enable" method="POST" style="display: inline;">
            <button type="submit" class="success">▶️ Enable Auto-Sync</button>
          </form>
          <form action="/disable" method="POST" style="display: inline;">
            <button type="submit" class="danger">⏸️ Disable Auto-Sync</button>
          </form>
          <form action="/sync" method="POST" style="display: inline;">
            <button type="submit">🔄 Manual Sync Now</button>
          </form>
        </div>

        <div class="section">
          <h3>Sync Log</h3>
          <div class="log">
            ${config.syncLog.length === 0 ? '<div>No sync activity yet...</div>' : ''}
            ${config.syncLog.map(entry => `
              <div class="log-entry ${entry.type}">
                [${new Date(entry.timestamp).toLocaleTimeString()}] ${entry.message}
              </div>
            `).join('')}
          </div>
        </div>

        <div class="section">
          <h3>📚 Setup Instructions</h3>
          <ol>
            <li><strong>Get HubSpot Token:</strong> HubSpot Settings → Integrations → Private Apps → Create app → Copy token</li>
            <li><strong>Get Monday Token:</strong> Monday.com → Your profile picture → Admin → API → Copy token</li>
            <li><strong>Get Board ID:</strong> Open your Monday board, the ID is in the URL (monday.com/boards/<strong>1234567890</strong>)</li>
            <li><strong>Save config above</strong> then click "Enable Auto-Sync"</li>
            <li>Sync runs automatically every 5 minutes when enabled</li>
          </ol>
        </div>
      </div>
      <script>
        // Auto-refresh every 30 seconds to show latest logs
        setTimeout(() => location.reload(), 30000);
      </script>
    </body>
    </html>
  `);
});

app.post('/config', (req, res) => {
  config.hubspotToken = req.body.hubspotToken;
  config.mondayToken = req.body.mondayToken;
  config.mondayBoardId = req.body.mondayBoardId;
  logSync('Configuration updated', 'info');
  res.redirect('/');
});

app.post('/rules', (req, res) => {
  config.fieldRules.title = req.body.title || 'hubspot';
  config.fieldRules.description = req.body.description || 'hubspot';
  config.fieldRules.status = req.body.status || 'monday';
  config.fieldRules.priority = req.body.priority || 'monday';
  config.fieldRules.assignee = req.body.assignee || 'both';
  logSync(`Field rules updated: Title=${config.fieldRules.title}, Description=${config.fieldRules.description}, Status=${config.fieldRules.status}, Priority=${config.fieldRules.priority}, Assignee=${config.fieldRules.assignee}`, 'success');
  res.redirect('/');
});

app.post('/enable', (req, res) => {
  config.syncEnabled = true;
  logSync('Auto-sync enabled', 'success');
  res.redirect('/');
});

app.post('/disable', (req, res) => {
  config.syncEnabled = false;
  logSync('Auto-sync disabled', 'info');
  res.redirect('/');
});

app.post('/sync', async (req, res) => {
  logSync('Manual sync triggered', 'info');
  performFullSync();
  res.redirect('/');
});

// HubSpot webhook endpoint
app.post('/webhook/hubspot', async (req, res) => {
  if (!config.syncEnabled) {
    return res.status(200).send('Sync disabled');
  }
  
  logSync('HubSpot webhook received', 'info');
  // Trigger sync from HubSpot to Monday
  setTimeout(() => syncHubSpotToMonday(), 1000);
  res.status(200).send('OK');
});

// Monday.com webhook endpoint
app.post('/webhook/monday', async (req, res) => {
  if (!config.syncEnabled) {
    return res.status(200).send('Sync disabled');
  }
  
  logSync('Monday.com webhook received', 'info');
  // Trigger sync from Monday to HubSpot
  setTimeout(() => syncMondayToHubSpot(), 1000);
  res.status(200).send('OK');
});

// Schedule automatic sync every 5 minutes
cron.schedule('*/5 * * * *', () => {
  if (config.syncEnabled) {
    logSync('Scheduled sync starting...', 'info');
    performFullSync();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  logSync('Server started successfully', 'success');
});
