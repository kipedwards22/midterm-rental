import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as any

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
