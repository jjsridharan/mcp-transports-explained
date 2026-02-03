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
 * Step 4: tools/call
 **************************************/
async function callTool(sessionId) {
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
 * Full lifecycle runner
 **************************************/
(async () => {
  try {
    await callTool(sessionId=null);

    console.log("✅ Individual tool call completed.");
  } catch (err) {
    console.error("❌ Individual tool call failed:", err);
  }
})();
