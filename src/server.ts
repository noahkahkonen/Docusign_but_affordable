import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Heroku assigns PORT; bind 0.0.0.0 so the dyno's router can reach us.
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info(`${env.BRAND_NAME} backend listening on ${env.APP_BASE_URL}`);
}

main().catch((err) => {
  logger.error(err, "Fatal startup error");
  process.exit(1);
});
