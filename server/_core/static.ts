import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";

export function serveStatic(app: Express) {
  const directory = path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(path.join(directory, "index.html"))) throw new Error("Client build is missing.");
  app.use(express.static(directory));
  app.get("*", (_req, res) => res.sendFile(path.join(directory, "index.html")));
}
