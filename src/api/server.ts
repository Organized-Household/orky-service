import express from "express";
import { registerRoutes } from "./routes";

export function startServer() {
  const app = express();
  app.use(express.json());

  registerRoutes(app);

  const port = Number(process.env.PORT ?? 3005);
  app.listen(port, () => {
    console.log(`Orky Control API listening on http://localhost:${port}`);
  });
}

