// Ensures the bundled MCP stdio server exists before packaging so the
// extraResources copy (resources/mcp/BrightMonMcpServer.mjs) always has a
// source file, regardless of which npm script triggered the build.
const { buildMcpBundle } = require("../mcp/build-mcpb.js")

exports.default = async function (context) {
    console.log("  • beforePack building BrightMon MCP server bundle")
    await buildMcpBundle()
}
