// Preloaded (`node --import`) into the capture's CLI subprocesses: freezes Date.now so open-interval ages are exact (ASTF-42 S-04a1, T-C1).
const FROZEN_NOW = Date.parse('2026-01-02T00:00:00Z');
Date.now = () => FROZEN_NOW;
