import Queue from "bull";
import { prisma } from "../lib/prisma";
import { syncAllListingsForHost, syncListingByGuestyId } from "../services/listingSync";
import { syncCalendarForListing } from "../services/calendarSync";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  // In development it is useful to fail fast if Redis is misconfigured.
  // You can relax this to a warning if you prefer.
  throw new Error("REDIS_URL environment variable must be set to use Bull queues");
}

export const syncQueue = new Queue("sync-jobs", redisUrl);

type SyncListingsJobData = {
  hostId: number;
};

type SyncSingleListingJobData = {
  hostId: number;
  guestyListingId: string;
};

type SyncCalendarJobData = {
  listingId: number;
};

type SyncAllHostsJobData = Record<string, never>;

// Process: sync all listings for a specific host
syncQueue.process("sync-listings", async (job) => {
  const { hostId } = job.data;
  await syncAllListingsForHost(hostId);
});

// Process: sync a single listing from Guesty by listing ID
syncQueue.process("sync-single-listing", async (job) => {
  const { hostId, guestyListingId } = job.data;
  await syncListingByGuestyId(hostId, guestyListingId);
});

// Process: sync calendar availability for a single listing
syncQueue.process("sync-calendar", async (job) => {
  const { listingId } = job.data;
  await syncCalendarForListing(listingId);
});

// Process: sync all connected hosts (used by recurring job)
syncQueue.process("sync-all-hosts", async () => {
  const hosts = await prisma.host.findMany({
    where: {
      guestyAccountId: { not: null },
      guestyRefreshToken: { not: null },
    },
    select: { id: true },
  });

  for (const host of hosts) {
    await syncQueue.add("sync-listings", { hostId: host.id });
  }
});

// Register a recurring job every 6 hours to re-sync all connected hosts.
// The combination of name + repeat + jobId ensures we only have one repeatable job.
void syncQueue.add(
  "sync-all-hosts",
  {},
  {
    jobId: "sync-all-hosts-recurring",
    repeat: {
      cron: "0 */6 * * *", // every 6 hours, on the hour (UTC)
      tz: "UTC",
    },
  }
);

