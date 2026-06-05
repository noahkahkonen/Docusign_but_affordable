import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

// Single shared client. In dev with hot-reload we stash it on globalThis so repeated
// module evaluation doesn't open a new connection pool each time.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.isProduction ? ["error", "warn"] : ["error", "warn"],
  });

if (!env.isProduction) {
  globalForPrisma.prisma = prisma;
}
