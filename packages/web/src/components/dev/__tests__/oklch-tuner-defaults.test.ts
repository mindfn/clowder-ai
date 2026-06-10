import { describe, expect, it } from 'vitest';
import { exportText } from '../oklch-tuner-css';
import { INIT_LIGHT } from '../oklch-tuner-engine';

describe('OKLCH tuner defaults', () => {
  it('exports the CVO-tuned light token defaults', () => {
    expect(exportText(INIT_LIGHT, 'light')).toBe(
      [
        'OKLCH Token Values (light)',
        'accent H=50 C=0.14',
        'surface H=80 C*=1',
        '==============================',
        'light:',
        '  primary   L=0.62  C*1.00',
        '  surface   L=0.85  C*0.45',
        '  text      L=0.24  C*0.80',
        '  inset     L=0.25  C*0.15',
        '  ring      L=0.55  C*1.10',
        '  insetText L=0.85  C=0.030',
        '  msgText   L=0.25  C=0.010',
        '  elevation: 0.92/0.95/0.99/0.995',
        '',
        'semantic (light):',
        '  H: crit=35 suc=135 warn=45 info=210  L=0.55 C=0.120 surfL=0.96 surfC=0.030',
        'queue: H=300 C=0.12 L=0.5',
        'neutral: H=30 C=0.005  txt=0.2 sec=0.45 mut=0.56 int=0.36 bdr=0.84 sub=0.915 codeBg=0.9 codeTx=0.19',
        'catText: H=5 C=0.025 L=0.15',
      ].join('\n'),
    );
  });
});
