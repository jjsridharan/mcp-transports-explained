/**************************************
 * MCP Legacy SSE Client with Request Tracking
 * 
 * Supports:
 * - Parallel requests with proper correlation
 * - Progress notifications per request
 * - Promise-based response handling
 * - Automatic request ID management
 **************************************/

/**************************************
 * CONFIG
 **************************************/
const MCP_CONFIG = {
  sseUrl: "http://localhost:5050/mcp/sse",
  accessToken: "",
};

/**************************************
 * State Management
 **************************************/
let messageEndpoint = null;
let requestId = 0;
let sseConnected = false;

// Map of pending requests: id → { resolve, reject, progressToken, onProgress }
const pendingRequests = new Map();

// Map of progressToken → requestId for correlating progress notifications
const progressTokenToRequestId = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**************************************
 * SSE Connection Management
 **************************************/
async function connectSse() {
  if (sseConnected) {
    console.log("SSE already connected");
    return;
  }

  console.log("🔌 Connecting to legacy SSE endpoint...");

  const response = await fetch(MCP_CONFIG.sseUrl, {
    method: "GET",
    headers: {
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${MCP_CONFIG.accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
  }

  console.log("✅ SSE connected, waiting for endpoint event...");
  sseConnected = true;

  // Start processing SSE in background (fire and forget)
  processSseStream(response);

  // Wait for endpoint to be received
  await waitForEndpoint();
  
  console.log("🚀 MCP client ready!");
  return response;
}

async function waitForEndpoint(timeoutMs = 10000) {
  const startTime = Date.now();
  
  while (!messageEndpoint) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error("Timeout waiting for SSE endpoint event");
    }
    await sleep(50);
  }
  
  console.log("📍 Message endpoint:", messageEndpoint);
}

async function processSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      
      if (done) {
        console.log("📴 SSE stream closed");
        sseConnected = false;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop(); // Keep incomplete frame in buffer

      for (const frame of frames) {
        if (!frame.trim()) continue;
        processFrame(frame);
      }
    }
  } catch (err) {
    console.error("❌ SSE read error:", err);
    sseConnected = false;
  }
}

function processFrame(frame) {
  const lines = frame.split("\n");
  let eventType = "message";
  let data = "";
  let eventId = "";

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data += line.slice(5).trim();
    } else if (line.startsWith("id:")) {
      eventId = line.slice(3).trim();
    }
  }

  // Handle endpoint event (tells us where to POST)
  if (eventType === "endpoint") {
    messageEndpoint = new URL(data, MCP_CONFIG.sseUrl.replace("/sse", "")).href;
    return;
  }

  // Handle message events
  if (eventType === "message" && data) {
    try {
      const payload = JSON.parse(data);
      handleSseMessage(payload);
    } catch (e) {
      console.warn("Failed to parse SSE message:", data);
    }
  }
}

/**************************************
 * Message Handling
 **************************************/
function handleSseMessage(payload) {
  // Handle progress notifications
  if (payload.method === "notifications/progress") {
    handleProgressNotification(payload);
    return;
  }

  // Handle responses (have id field)
  if (payload.id !== undefined) {
    handleResponse(payload);
    return;
  }

  // Handle other notifications
  if (payload.method) {
    console.log(`📨 Notification: ${payload.method}`, payload.params);
    return;
  }

  console.log("📩 Unknown message:", payload);
}

function handleProgressNotification(payload) {
  const progressToken = payload.params?.progressToken;
  const progress = payload.params?.progress;
  const total = payload.params?.total;
  const message = payload.params?.message;

  // Find the request associated with this progressToken
  const reqId = progressTokenToRequestId.get(progressToken);
  
  if (reqId !== undefined) {
    const pending = pendingRequests.get(reqId);
    if (pending?.onProgress) {
      pending.onProgress({
        progressToken,
        progress,
        total,
        message,
        percentage: total ? Math.round((progress / total) * 100) : null
      });
    }
  }

  // Log with color based on progress
  const pct = total ? `${Math.round((progress / total) * 100)}%` : `${progress}`;
  console.log(`📊 [${progressToken?.slice(0, 8)}...] Progress: ${pct} - ${message}`);
}

function handleResponse(payload) {
  const { id, result, error } = payload;
  const pending = pendingRequests.get(id);

  if (!pending) {
    console.warn(`⚠️ Received response for unknown request ID: ${id}`);
    return;
  }

  // Clean up
  pendingRequests.delete(id);
  if (pending.progressToken) {
    progressTokenToRequestId.delete(pending.progressToken);
  }

  if (error) {
    console.error(`❌ [Request ${id}] Error:`, error);
    pending.reject(error);
  } else {
    console.log(`✅ [Request ${id}] Success`);
    pending.resolve(result);
  }
}

/**************************************
 * Request Sending
 **************************************/

/**
 * Send a JSON-RPC request and wait for response via SSE
 * @param {string} method - JSON-RPC method name
 * @param {object} params - Method parameters
 * @param {object} options - Additional options
 * @param {function} options.onProgress - Callback for progress notifications
 * @param {string} options.progressToken - Custom progress token (auto-generated if not provided)
 * @param {number} options.timeout - Request timeout in ms (default: 60000)
 * @returns {Promise<any>} - The result from the server
 */
async function sendRequest(method, params = {}, options = {}) {
  if (!messageEndpoint) {
    throw new Error("Not connected. Call connectSse() first.");
  }

  const id = ++requestId;
  const progressToken = options.progressToken || `req-${id}-${Date.now()}`;
  const timeout = options.timeout || 60000;

  // For tool calls, inject progressToken into arguments
  if (method === "tools/call" && params.arguments) {
    params.arguments = {
      ...params.arguments,
      progressToken
    };
  }

  const payload = {
    jsonrpc: "2.0",
    id,
    method,
    params
  };

  // Set up response promise with timeout
  const responsePromise = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pendingRequests.delete(id);
      progressTokenToRequestId.delete(progressToken);
      reject(new Error(`Request ${id} timed out after ${timeout}ms`));
    }, timeout);

    pendingRequests.set(id, {
      resolve: (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
      progressToken,
      onProgress: options.onProgress
    });

    progressTokenToRequestId.set(progressToken, id);
  });

  // Send the request
  const response = await fetch(messageEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MCP_CONFIG.accessToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    pendingRequests.delete(id);
    progressTokenToRequestId.delete(progressToken);
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  console.log(`📤 [Request ${id}] ${method}`);

  return responsePromise;
}

/**
 * Send a notification (no response expected)
 * @param {string} method - Notification method name
 * @param {object} params - Method parameters
 */
async function sendNotification(method, params = {}) {
  if (!messageEndpoint) {
    throw new Error("Not connected. Call connectSse() first.");
  }

  const payload = {
    jsonrpc: "2.0",
    method,
    ...(Object.keys(params).length > 0 && { params })
  };

  const response = await fetch(messageEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${MCP_CONFIG.accessToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
  }

  console.log(`📤 Notification: ${method}`);
}

/**************************************
 * High-Level MCP Operations
 **************************************/

/**
 * Initialize the MCP session
 */
async function initialize(clientInfo = { name: "browser-client", version: "1.0.0" }) {
  const result = await sendRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {
      roots: { listChanged: true },
      sampling: {}
    },
    clientInfo
  });

  // Send initialized notification
  await sendNotification("notifications/initialized");

  console.log("🤝 Session initialized:", result.serverInfo?.name);
  return result;
}

/**
 * List available tools
 */
async function listTools() {
  const result = await sendRequest("tools/list");
  console.log(`🔧 Available tools: ${result.tools?.length || 0}`);
  return result.tools || [];
}

/**
 * Call a tool with progress tracking
 * @param {string} toolName - Name of the tool to call
 * @param {object} args - Tool arguments
 * @param {function} onProgress - Progress callback
 */
async function callTool(toolName, args = {}, onProgress = null) {
  const result = await sendRequest("tools/call", {
    name: toolName,
    arguments: args
  }, { onProgress });

  return result;
}

/**
 * Call multiple tools in parallel
 * @param {Array<{name: string, args: object, onProgress?: function}>} toolCalls
 */
async function callToolsParallel(toolCalls) {
  const promises = toolCalls.map((call, index) => 
    callTool(call.name, call.args, call.onProgress)
      .then(result => ({ index, name: call.name, success: true, result }))
      .catch(error => ({ index, name: call.name, success: false, error }))
  );

  return Promise.all(promises);
}

/**************************************
 * Utility Functions
 **************************************/

function getConnectionStatus() {
  return {
    connected: sseConnected,
    messageEndpoint,
    pendingRequests: pendingRequests.size
  };
}

function disconnect() {
  // Clear all pending requests
  for (const [id, pending] of pendingRequests) {
    pending.reject(new Error("Disconnected"));
  }
  pendingRequests.clear();
  progressTokenToRequestId.clear();
  
  messageEndpoint = null;
  sseConnected = false;
  requestId = 0;
  
  console.log("🔌 Disconnected");
}

/**************************************
 * Example Usage
 **************************************/
async function main() {
  try {
    // 1. Connect to SSE
    await connectSse();

    // 2. Initialize session
    await initialize();

    // 3. List available tools
    const tools = await listTools();
    console.log("Tools:", tools.map(t => t.name).join(", "));

    // 4. Single tool call with progress
    console.log("\n--- Single Tool Call ---");
    const result1 = await callTool(
      "toolA",
      { 
        hostName: "device01", 
        commands: ["show version", "show interfaces"] 
      },
      (progress) => {
        console.log(`🔵 Device01: ${progress.percentage}% - ${progress.message}`);
      }
    );
    console.log("Result:", result1);

    // 5. Parallel tool calls with individual progress tracking
    console.log("\n--- Parallel Tool Calls ---");
    const parallelResults = await callToolsParallel([
      {
        name: "toolA",
        args: { hostName: "router-a", commands: ["show version", "show ip route"] },
        onProgress: (p) => console.log(`🔴 Router-A: ${p.percentage}% - ${p.message}`)
      },
      {
        name: "toolA",
        args: { hostName: "switch-b", commands: ["show vlan", "show mac-address-table"] },
        onProgress: (p) => console.log(`🟢 Switch-B: ${p.percentage}% - ${p.message}`)
      },
      {
        name: "toolA",
        args: { hostName: "firewall-c", commands: ["show access-lists"] },
        onProgress: (p) => console.log(`🟡 Firewall-C: ${p.percentage}% - ${p.message}`)
      }
    ]);

    console.log("\n--- Results ---");
    for (const r of parallelResults) {
      if (r.success) {
        console.log(`✅ ${r.name}: Success`);
      } else {
        console.log(`❌ ${r.name}: ${r.error.message}`);
      }
    }

    console.log("\n✅ All operations completed!");
    console.log("Status:", getConnectionStatus());

  } catch (err) {
    console.error("❌ Error:", err);
  }
}

// Run the example
main();