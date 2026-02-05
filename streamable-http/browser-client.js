/**
 * ⚠️ SETUP INSTRUCTIONS ⚠️
 * 
 * Before running this script, you must update the following:
 * 1. Set `MCP_CONFIG.url` to your running MCP server endpoint
 * 2. Set `MCP_CONFIG.accessToken` if your server requires authentication (JWT)
 * 3. Update the `callTool` function (Step 4) with a valid tool name and arguments for your server
 */

/**************************************
 * CONFIG (single source of truth)
 **************************************/
const MCP_CONFIG = {
  url: "<url>",
  accessToken: "",          // optional
  devtoolsDelayMs: 1000     // delay before reading streams (learning/debug)
};

/**************************************
 * Utilities
 **************************************/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHeaders(sessionId) {
  return {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    ...(MCP_CONFIG.accessToken && {
      "Authorization": `Bearer ${MCP_CONFIG.accessToken}`
    }),
    ...(sessionId && {
      "Mcp-Session-Id": sessionId
    })
  };
}

/**************************************
 * Core MCP HTTP helper
 **************************************/
async function mcpPost({ sessionId, payload }) {
  return fetch(MCP_CONFIG.url, {
    method: "POST",
    credentials: "include", // required for cookie-based MCP
    headers: buildHeaders(sessionId),
    body: JSON.stringify(payload)
  });
}

/**************************************
 * SSE stream reader
 **************************************/
async function streamAndParse(response, onMessage) {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split("\n\n");
    buffer = frames.pop(); // keep incomplete frame

    for (const frame of frames) {
      const dataLine = frame
        .split("\n")
        .find((l) => l.startsWith("data:"));

      if (!dataLine) continue;

      const payload = JSON.parse(dataLine.slice(5).trim());
      onMessage(payload);
    }
  }
}

/**************************************
 * Step 1: initialize
 **************************************/
async function initialize() {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {
        roots: { listChanged: true },
        sampling: {}
      },
      clientInfo: {
        name: "browser-client",
        version: "1.0.0"
      }
    }
  };

  const response = await mcpPost({ sessionId: null, payload });
  const sessionId = response.headers.get("Mcp-Session-Id");

  console.log("initialize status:", response.status);
  console.log(
    sessionId
      ? "Detected session-based MCP"
      : "Detected cookie-based MCP"
  );

  await sleep(MCP_CONFIG.devtoolsDelayMs);

  await streamAndParse(response, (msg) => {
    console.log("initialize response:", msg);
  });

  return sessionId; // may be null
}

/**************************************
 * Step 2: notifications/initialized
 **************************************/
async function notifyInitialized(sessionId) {
  const payload = {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  };

  const response = await mcpPost({ sessionId, payload });
  console.log("notifications/initialized status:", response.status);
}

/**************************************
 * Step 3: tools/list
 **************************************/
async function listTools(sessionId) {
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  };

  const response = await mcpPost({ sessionId, payload });
  console.log("tools/list status:", response.status);

  await sleep(MCP_CONFIG.devtoolsDelayMs);

  await streamAndParse(response, (msg) => {
    if (msg.result?.tools) {
      console.log("Available tools:", msg.result.tools);
    }
  });
}

/**************************************
 * Step 4: tools/call
 **************************************/
async function callTool(sessionId) {
  // ⚠️ UPDATE THIS with a real tool from your server
  const payload = {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "<tool_name>",
      arguments: {
        param1: "value1",
        param2: [
          "value2a",
          "value2b"
        ]
      }
    }
  };

  const response = await mcpPost({ sessionId, payload });
  console.log("tools/call status:", response.status);

  // allow time to observe SSE in DevTools
  await sleep(5000);

  await streamAndParse(response, (msg) => {
    if (msg.method === "notifications/progress") {
      console.log("Progress:", msg.params);
    }

    if (msg.result) {
      console.log("Tool result:", msg.result);
    }

    if (msg.error) {
      console.error("Tool error:", msg.error);
    }
  });
}

/**************************************
 * Step 5: close session (optional)
 **************************************/
async function closeSession(sessionId) {
  if (!sessionId) {
    console.log("Cookie-based MCP: no explicit session to close");
    return;
  }

  const response = await fetch(MCP_CONFIG.url, {
    method: "DELETE",
    credentials: "include",
    headers: buildHeaders(sessionId)
  });

  console.log("session close status:", response.status);
}

/**************************************
 * Full lifecycle runner
 **************************************/
(async () => {
  try {
    const sessionId = await initialize();
    await notifyInitialized(sessionId);
    await listTools(sessionId);
    await callTool(sessionId);
    await closeSession(sessionId);

    console.log("✅ MCP lifecycle completed cleanly");
  } catch (err) {
    console.error("❌ MCP lifecycle failed:", err);
  }
})();
