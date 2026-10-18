/**
 * Teams: the 2026 grid. One port of f1-game js/data/teams.js serves the whole
 * game: the car lane's src/car/teams.ts. This module re-exports it so the Data
 * Hub and older imports keep their path (coordinator-approved dedupe,
 * 2026-10-18).
 */
export * from "../car/teams";
export type { Driver as TeamDriver } from "../car/teams";
