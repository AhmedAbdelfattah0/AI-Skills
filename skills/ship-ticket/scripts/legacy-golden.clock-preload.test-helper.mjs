// Preloaded (`node --import`) into the capture's CLI subprocesses: freezes Date.now so open-interval ages are exact (ASTF-42 S-04a1, T-C1).
import { FROZEN_NOW } from './legacy-golden.clock.test-helper.mjs';
Date.now = () => FROZEN_NOW;
