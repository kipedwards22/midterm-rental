import { Router, Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { prisma } from "../lib/prisma";
import { syncQueue } from "../jobs/syncQueue";

const router = Router();

type AuthPayload = JwtPayload & {
  sub?: string | number;
  hostId?: number;
};

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET environment variable must be set");
  }
  return secret;
}

function getHostIdFromRequest(req: Request): number | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as AuthPayload | string;
    if (typeof decoded === "string") {
      return null;
    }

    if (typeof decoded.hostId === "number") {
      return decoded.hostId;
    }

    if (decoded.sub != null) {
      const subNum = Number(decoded.sub);
      if (Number.isFinite(subNum)) {
        return subNum;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function requireHostAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const hostId = getHostIdFromRequest(req);
  if (!hostId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Attach to request for downstream handlers (using any to avoid extending Express types here)
  (req as any).hostId = hostId;
  next();
}

// Public listing search
router.get("/", async (req, res) => {
  try {
    const city =
      typeof req.query.city === "string" ? req.query.city : undefined;
    const state =
      typeof req.query.state === "string" ? req.query.state : undefined;

    const bedroomsParam =
      typeof req.query.bedrooms === "string"
        ? req.query.bedrooms
        : undefined;
    const bedroomsMinParam =
      typeof req.query.bedroomsMin === "string"
        ? req.query.bedroomsMin
        : undefined;
    const bedroomsMaxParam =
      typeof req.query.bedroomsMax === "string"
        ? req.query.bedroomsMax
        : undefined;

    const minPriceParam =
      typeof req.query.minPrice === "string"
        ? req.query.minPrice
        : undefined;
    const maxPriceParam =
      typeof req.query.maxPrice === "string"
        ? req.query.maxPrice
        : undefined;

    const startDateParam =
      typeof req.query.startDate === "string"
        ? req.query.startDate
        : undefined;
    const endDateParam =
      typeof req.query.endDate === "string"
        ? req.query.endDate
        : undefined;

    const pageParam =
      typeof req.query.page === "string" ? req.query.page : undefined;
    const pageSizeParam =
      typeof req.query.pageSize === "string"
        ? req.query.pageSize
        : undefined;

    const page = Math.max(
      1,
      pageParam ? Number.parseInt(pageParam, 10) : 1
    );
    const pageSize = Math.min(
      50,
      Math.max(
        1,
        pageSizeParam ? Number.parseInt(pageSizeParam, 10) : 20
      )
    );

    const bedrooms =
      bedroomsParam != null ? Number.parseInt(bedroomsParam, 10) : undefined;
    const bedroomsMin =
      bedroomsMinParam != null
        ? Number.parseInt(bedroomsMinParam, 10)
        : undefined;
    const bedroomsMax =
      bedroomsMaxParam != null
        ? Number.parseInt(bedroomsMaxParam, 10)
        : undefined;

    const minPrice =
      minPriceParam != null ? Number.parseFloat(minPriceParam) : undefined;
    const maxPrice =
      maxPriceParam != null ? Number.parseFloat(maxPriceParam) : undefined;

    const startDate =
      startDateParam != null ? new Date(startDateParam) : undefined;
    const endDate =
      endDateParam != null ? new Date(endDateParam) : undefined;

    const where: any = {};

    if (city) {
      where.city = { equals: city, mode: "insensitive" };
    }

    if (state) {
      where.state = { equals: state, mode: "insensitive" };
    }

    if (Number.isFinite(bedrooms as number)) {
      where.bedrooms = bedrooms;
    } else {
      if (Number.isFinite(bedroomsMin as number)) {
        where.bedrooms = where.bedrooms ?? {};
        where.bedrooms.gte = bedroomsMin;
      }
      if (Number.isFinite(bedroomsMax as number)) {
        where.bedrooms = where.bedrooms ?? {};
        where.bedrooms.lte = bedroomsMax;
      }
    }

    if (startDate || endDate || Number.isFinite(minPrice as number) || Number.isFinite(maxPrice as number)) {
      const calendarFilter: any = {};

      if (startDate) {
        calendarFilter.date = calendarFilter.date ?? {};
        calendarFilter.date.gte = startDate;
      }
      if (endDate) {
        calendarFilter.date = calendarFilter.date ?? {};
        calendarFilter.date.lte = endDate;
      }

      calendarFilter.available = true;

      if (Number.isFinite(minPrice as number)) {
        calendarFilter.price = calendarFilter.price ?? {};
        calendarFilter.price.gte = minPrice;
      }
      if (Number.isFinite(maxPrice as number)) {
        calendarFilter.price = calendarFilter.price ?? {};
        calendarFilter.price.lte = maxPrice;
      }

      where.calendarDays = { some: calendarFilter };
    }

    const listings = await prisma.listing.findMany({
      where,
      orderBy: {
        createdAt: "desc",
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        title: true,
        description: true,
        city: true,
        state: true,
        bedrooms: true,
        bathrooms: true,
        maxGuests: true,
        photos: true,
        amenities: true,
        basePrice: true,
      },
    });

    res.json({
      page,
      pageSize,
      results: listings,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in GET /listings", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Host's own listings (protected)
router.get("/me", requireHostAuth, async (req, res) => {
  try {
    const hostId = (req as any).hostId as number;

    const listings = await prisma.listing.findMany({
      where: { hostId },
      orderBy: { createdAt: "desc" },
    });

    res.json({ listings });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in GET /listings/me", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manual sync trigger for a host (protected)
router.post("/sync", requireHostAuth, async (req, res) => {
  try {
    const hostId = (req as any).hostId as number;

    await syncQueue.add("sync-listings", { hostId });

    res.status(202).json({ queued: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in POST /listings/sync", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Single listing detail (public)
router.get("/:id", async (req, res) => {
  try {
    const idNum = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(idNum)) {
      res.status(400).json({ error: "Invalid listing id" });
      return;
    }

    const listing = await prisma.listing.findUnique({
      where: { id: idNum },
      include: {
        calendarDays: {
          where: {
            date: { gte: new Date() },
          },
          orderBy: {
            date: "asc",
          },
          take: 180, // up to ~6 months of days
        },
      },
    });

    if (!listing) {
      res.status(404).json({ error: "Listing not found" });
      return;
    }

    res.json({ listing });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Error in GET /listings/:id", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;

