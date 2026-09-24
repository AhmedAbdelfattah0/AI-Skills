import { writeFileSync } from 'node:fs';

if (process.env.UX_AUDIT_EXECUTED_CONFIG) {
  writeFileSync(process.env.UX_AUDIT_EXECUTED_CONFIG, 'executed');
  throw new Error('ux-audit must never execute this config');
}

export default {
  theme: {
    extend: {
      spacing: { panel: '18px' },
      colors: { brand: '#5b8def' },
      borderRadius: { card: '7px' }
    }
  }
};
