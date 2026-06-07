const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class MongoMCPClient extends EventEmitter {
  constructor(mongoUri) {
    super();
    this.mongoUri = mongoUri;
    this.process = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.buffer = '';
    this.ready = false;
    this.initialized = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.log('🔌 Starting MongoDB MCP Server...');

      const isWindows = process.platform === 'win32';
      const npxCmd = isWindows ? 'npx.cmd' : 'npx';

      this.process = spawn(npxCmd, ['-y', 'mongodb-mcp-server'], {
        env: {
          ...process.env,
          MDB_MCP_CONNECTION_STRING: this.mongoUri,
          MDB_MCP_DISABLED_TOOLS: 'drop-collection,drop-database'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      });

      this.process.stderr.on('data', (data) => {
        const msg = data.toString();
        console.log('🔍 MCP stderr:', msg.trim().substring(0, 100));
        if (msg.includes('Server started') || msg.includes('listening') ||
            msg.includes('connected') || msg.includes('ready') || msg.includes('MCP')) {
          if (!this.ready) {
            console.log('✅ MongoDB MCP Server ready');
            this.ready = true;
            resolve();
          }
        }
      });

      this.process.stdout.on('data', (data) => {
        this.buffer += data.toString();
        this._processBuffer();
      });

      this.process.on('error', (err) => {
        console.error('❌ MCP Server process error:', err.message);
        reject(err);
      });

      this.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          console.log(`⚠️ MCP Server exited with code ${code}`);
        }
      });

      // Initialize MCP protocol after spawn
      setTimeout(async () => {
        if (!this.initialized) {
          try {
            await this._initialize();
            this.initialized = true;
            if (!this.ready) {
              console.log('✅ MongoDB MCP Server initialized');
              this.ready = true;
              resolve();
            }
          } catch (err) {
            console.log('⚠️ MCP init failed:', err.message);
            if (!this.ready) {
              this.ready = true;
              resolve();
            }
          }
        }
      }, 2000);

      // Final fallback
      setTimeout(() => {
        if (!this.ready) {
          console.log('⏱️ MCP Server assumed ready after timeout');
          this.ready = true;
          resolve();
        }
      }, 8000);
    });
  }

  async _initialize() {
    // Send MCP initialize handshake
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'joblens', version: '1.0.0' }
        }
      }) + '\n';

      this.pendingRequests.set(id, { resolve, reject });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          resolve(); // Don't reject — just proceed
        }
      }, 5000);

      this.process.stdin.write(request);
    });
  }

  _processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {
        // Not JSON — ignore
      }
    }
  }

  async call(method, params = {}) {
    if (!this.ready) throw new Error('MCP Server not ready');

    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      }) + '\n';

      this.pendingRequests.set(id, { resolve, reject });

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 15000);

      this.process.stdin.write(request);
    });
  }

  // Parse MCP tool response — strips security tags and markdown blocks safely
  _parseToolResult(result) {
    if (!result || !result.content) return null;

    for (const block of result.content) {
      if (block.type === 'text' && block.text) {
        let text = block.text;

        // 1. Strip the security tags if they exist
        if (text.includes('<untrusted-user-data-')) {
          const startTag = text.indexOf('>', text.indexOf('<untrusted-user-data-')) + 1;
          const endTag = text.lastIndexOf('</untrusted-user-data-');
          if (startTag > 0 && endTag > startTag) {
            text = text.substring(startTag, endTag).trim();
          }
        }

        // 2. Strip any markdown JSON formatting the MCP server might add
        text = text.replace(/^```json/i, '').replace(/```$/, '').trim();

        try {
          // 3. Isolate the JSON array natively (avoids greedy regex freezing on huge strings)
          const firstBracket = text.indexOf('[');
          const lastBracket = text.lastIndexOf(']');
          if (firstBracket !== -1 && lastBracket > firstBracket) {
            const pureJson = text.substring(firstBracket, lastBracket + 1);
            return JSON.parse(pureJson);
          }
          // Fallback to direct parse
          return JSON.parse(text);
        } catch (err) {
          // If it fails, let it loop to the next text block
          continue; 
        }
      }
    }

    const fallbackBlock = result.content.find(c => c.type === 'text' && !c.text.includes('WARNING'));
    return fallbackBlock ? fallbackBlock.text : null;
  }

  // --- High-level MongoDB operations via MCP ---

  async saveInvestigation(record) {
    try {
      const result = await this.call('tools/call', {
        name: 'insert-many',
        arguments: {
          database: 'joblens',
          collection: 'investigations',
          documents: [record]
        }
      });
      const parsed = this._parseToolResult(result);
      console.log('💾 [MCP] Saved investigation to MongoDB Atlas');
      return parsed || true;
    } catch (err) {
      console.error('⚠️ [MCP] Save failed:', err.message);
      return null;
    }
  }

  async findInvestigation(url) {
    try {
      const result = await this.call('tools/call', {
        name: 'find',
        arguments: {
          database: 'joblens',
          collection: 'investigations',
          filter: { url },
          limit: 1
        }
      });
      const parsed = this._parseToolResult(result);
      const docs = parsed?.documents || parsed?.result || (Array.isArray(parsed) ? parsed : null);
      if (docs && docs.length > 0) {
        console.log('📦 [MCP] Cache hit via MongoDB MCP');
        return docs[0];
      }
      return null;
    } catch (err) {
      console.error('⚠️ [MCP] Find failed:', err.message);
      return null;
    }
  }

  async getHistory(limit = 20) {
    try {
      const result = await this.call('tools/call', {
        name: 'find',
        arguments: {
          database: 'joblens',
          collection: 'investigations',
          filter: {},
          sort: { investigatedAt: -1 },
          limit,
          // PROJECTION: Tell MongoDB to only return the lightweight fields the UI needs.
          // This stops the 4,000-character scraped descriptions from blowing up the payload size.
          projection: { jobTitle: 1, company: 1, verdict: 1, investigatedAt: 1 }
        }
      });

      const parsed = this._parseToolResult(result);
      const docs = parsed?.documents || parsed?.result || (Array.isArray(parsed) ? parsed : null);

      if (docs) {
        console.log(`📋 [MCP] Fetched ${docs.length} history items`);
        return docs;
      }
      
      console.log('⚠️ [MCP] Could not parse history, falling back to driver');
      return null;
    } catch (err) {
      console.error('⚠️ [MCP] History failed:', err.message);
      return null;
    }
  }

  async getStats() {
    try {
      const countDocs = async (filter) => {
        const result = await this.call('tools/call', {
          name: 'count',
          arguments: {
            database: 'joblens',
            collection: 'investigations',
            filter: filter,
            query: filter // MCP server uses 'query' instead of 'filter' for the count tool
          }
        });
        
        // MCP returns natural language: "Found 13 documents in the collection"
        if (result?.content && Array.isArray(result.content)) {
          const textBlock = result.content.find(c => c.type === 'text');
          if (textBlock?.text) {
            const match = textBlock.text.match(/(\d+)/);
            if (match) return parseInt(match[1]);
          }
        }
        return 0;
      };

      const [total, apply, caution, ghost] = await Promise.all([
        countDocs({}),
        countDocs({ verdict: 'APPLY' }),
        countDocs({ verdict: 'CAUTION' }),
        countDocs({ verdict: 'GHOST' })
      ]);

      console.log('📊 [MCP] Stats fetched via MongoDB MCP');
      return { total, apply, caution, ghost };
    } catch (err) {
      console.error('⚠️ [MCP] Stats failed:', err.message);
      return null;
    }
  }

  disconnect() {
    if (this.process) {
      this.process.kill();
      console.log('🔌 MongoDB MCP Server disconnected');
    }
  }
}

module.exports = MongoMCPClient;