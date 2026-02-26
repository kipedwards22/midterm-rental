import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import authRouter from "./routes/auth";
import listingsRouter from "./routes/listings";
import webhooksRouter from "./routes/webhooks";

const app = express();

// Raw body for Guesty webhooks (useful for signature verification)
app.use(
  "/webhooks/guesty",
  express.raw({ type: "application/json" })
);

// Standard middleware for the rest of the API
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRouter);
app.use("/listings", listingsRouter);
app.use("/webhooks", webhooksRouter);

const port = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});

