import { run } from "@stricli/core";
import { app } from "../app.js";
import { buildContext } from "../context.js";

// Stricli reserves -H for --help-all. Pre-process to support curl-style -H for headers.
const args = process.argv.slice(2).map((a) => (a === "-H" ? "--header" : a));
await run(app, args, buildContext(process));
