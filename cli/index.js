#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import open from "open";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import ClaudeCodeTracer from "../proxy/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const program = new Command();

let tracerInstance = null;
let uiProcess = null;

// Constants
const UI_STARTUP_DELAY_MS = 2000;
const SEPARATOR_LINE = "─".repeat(60);

// Helper functions
function cleanup() {
  if (tracerInstance) {
    try {
      tracerInstance.stop();
    } catch (error) {
      console.error(chalk.red("Error stopping tracer:"), error.message);
    }
  }

  if (uiProcess) {
    try {
      uiProcess.kill();
    } catch (error) {
      console.error(chalk.red("Error stopping UI:"), error.message);
    }
  }
}

function displaySetupInstructions(port) {
  console.log(chalk.green("\n✅ Claude Code Tracer is running!\n"));
  console.log(
    chalk.yellow("Configure Claude Code with these environment variables:")
  );
  console.log(chalk.gray(SEPARATOR_LINE));
  console.log(
    chalk.white(`export ANTHROPIC_BASE_URL=\"http://localhost:${port}\"`)
  );
  console.log(chalk.white(`export ANTHROPIC_API_KEY=\"your-actual-api-key\"`));
  console.log(chalk.gray(SEPARATOR_LINE));
  console.log(chalk.cyan("\nThen run Claude Code normally:"));
  console.log(chalk.white("  claude\n"));
  console.log(chalk.gray("All requests will be traced and visible in the UI!"));
  console.log(chalk.gray("\nPress Ctrl+C to stop the tracer\n"));
}

program
  .name("claude-code-tracer")
  .description("Trace and visualize Claude Code LLM interactions")
  .version("0.1.0");

program
  .command("start")
  .description("Start the tracer proxy and UI")
  .option("-p, --port <port>", "proxy port", "3000")
  .option("-u, --ui-port <port>", "UI port", "3001")
  .option("--no-ui", "start without opening UI")
  .action(async (options) => {
    try {
      console.log(chalk.cyan("🚀 Starting Claude Code Tracer...\n"));

      tracerInstance = new ClaudeCodeTracer({
        port: options.port,
        uiPort: options.uiPort,
      });
      tracerInstance.start();

      if (options.ui !== false) {
        console.log(chalk.gray("Starting UI server..."));
        uiProcess = spawn("npm", ["run", "dev"], {
          cwd: path.join(__dirname, "../ui"),
          stdio: "inherit",
          env: {
            ...process.env,
            VITE_PROXY_URL: `http://localhost:${options.port}`,
            VITE_WS_URL: `ws://localhost:${Number(options.port) + 2}`,
          },
        });

        // Wait for UI server to initialize before opening browser
        await new Promise((resolve) =>
          setTimeout(resolve, UI_STARTUP_DELAY_MS)
        );

        console.log(chalk.cyan("📊 Opening tracer UI..."));
        await open(`http://localhost:${options.uiPort}`);
      }

      displaySetupInstructions(options.port);

      process.on("SIGINT", () => {
        console.log(chalk.yellow("\n\nShutting down Claude Code Tracer..."));
        cleanup();
        process.exit(0);
      });
    } catch (error) {
      console.error(chalk.red("Failed to start tracer:"), error);
      process.exit(1);
    }
  });

// Note: The "stop" command is primarily for consistency with CLI conventions.
// In practice, users should stop the tracer with Ctrl+C from the running process.
program
  .command("stop")
  .description("Stop the tracer (use Ctrl+C in the running process)")
  .action(() => {
    console.log(
      chalk.yellow(
        "Note: To stop the tracer, press Ctrl+C in the terminal where it's running."
      )
    );
    console.log(
      chalk.gray(
        "This command is provided for CLI consistency but doesn't manage running processes."
      )
    );
  });

program
  .command("export")
  .description("Export traces to file")
  .option("-f, --format <format>", "export format (json, csv)", "json")
  .option("-o, --output <file>", "output file")
  .action(async () => {
    console.log(chalk.cyan("Exporting traces..."));
    // TODO: Implement export in future iteration
  });

program.parse();
