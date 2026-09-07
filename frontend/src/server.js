const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const port = Number(process.env.FRONTEND_PORT || 3000);

app.use(express.static(path.join(__dirname, "public")));

app.get("/config", (_req, res) => {
    res.status(200).json({
        apiBaseUrl: process.env.API_BASE_URL || "http://localhost:8080"
    });
});

app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok", service: "frontend" });
});

app.listen(port, () => {
    console.log(`Frontend listening on port ${port}`);
});
