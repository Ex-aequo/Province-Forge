// Parameter sliders, grouped. Each slider writes straight into a GenParams object.
import type { GenParams } from '../gen/types';

type NumKey = { [K in keyof GenParams]: GenParams[K] extends number ? K : never }[keyof GenParams];

interface SliderDef {
  key: NumKey | `continentSizes.${0 | 1 | 2}` | 'autoScale';
  /** 'check' = a checkbox for a boolean parameter (min/max/step ignored). */
  kind?: 'check';
  label: string;
  min: number;
  max: number;
  step: number;
  fmt?: (v: number) => string;
  help?: string;
}

const pt = (v: number, d: number) => v.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const x = (v: number) => `×${pt(v, 2)}`;

export const GROUPS: { title: string; open?: boolean; sliders: SliderDef[] }[] = [
  {
    title: 'Mundo', open: true, sliders: [
      { key: 'landFraction', label: 'Proporção de terra', min: 0.2, max: 0.6, step: 0.01, fmt: pct },
      { key: 'polarMargin', label: 'Oceano polar', min: 0, max: 0.15, step: 0.01, fmt: pct, help: 'Mar aberto mantido nas margens norte e sul.' },
      { key: 'cellCount', label: 'Células de terreno', min: 12000, max: 50000, step: 1000, fmt: (v) => v.toLocaleString('pt-PT'), help: 'Resolução fina por baixo das províncias. Mais células = formas mais suaves, geração mais lenta.' },
      { key: 'relaxIterations', label: 'Relaxamento das células', min: 0, max: 3, step: 1 },
    ],
  },
  {
    title: 'Continentes', open: true, sliders: [
      { key: 'continentSizes.0', label: 'Quota do continente A', min: 0.4, max: 1.6, step: 0.05, fmt: x },
      { key: 'continentSizes.1', label: 'Quota do continente B', min: 0.4, max: 1.6, step: 0.05, fmt: x },
      { key: 'continentSizes.2', label: 'Quota do continente C', min: 0.4, max: 1.6, step: 0.05, fmt: x },
      { key: 'minStraitCells', label: 'Estreito mínimo', min: 2, max: 16, step: 1, fmt: (v) => `${v} células`, help: 'Mar aberto garantido entre continentes. 6 células ≈ duas zonas costeiras lado a lado.' },
      { key: 'coastRoughness', label: 'Recorte da costa', min: 0, max: 1.2, step: 0.05, fmt: (v) => pt(v, 2) },
      { key: 'islandCount', label: 'Ilhas', min: 0, max: 40, step: 1 },
    ],
  },
  {
    title: 'Províncias', open: true, sliders: [
      { key: 'landProvinces', label: 'Províncias terrestres', min: 300, max: 900, step: 10 },
      { key: 'minProvinceFraction', label: 'Tamanho mínimo', min: 0.2, max: 0.8, step: 0.05, fmt: (v) => `${pct(v)} da média`, help: 'As províncias mais pequenas são fundidas com as vizinhas, para que todas se possam tocar no iPad.' },
      { key: 'ridgeBorderWeight', label: 'Fronteiras seguem o relevo', min: 0, max: 3, step: 0.1, fmt: (v) => pt(v, 1) },
    ],
  },
  {
    title: 'Rios, lagos e clima', open: true, sliders: [
      { key: 'riverDensity', label: 'Densidade de rios', min: 0.02, max: 0.12, step: 0.005, fmt: (v) => `${pt(v * 100, 1)}%`, help: 'Parte das células de terra junto a um rio desenhado.' },
      { key: 'riverBorderWeight', label: 'Fronteiras seguem os rios', min: 0, max: 3, step: 0.1, fmt: (v) => pt(v, 1), help: '0 = os rios ignoram as províncias. Valores altos põem as fronteiras sobre os rios.' },
      { key: 'lakeCount', label: 'Lagos', min: 0, max: 20, step: 1 },
      { key: 'polarIce', label: 'Gelo polar', min: 0, max: 0.08, step: 0.005, fmt: (v) => `${pt(v * 100, 1)}% da altura` },
      { key: 'temperatureBias', label: 'Clima mais quente / frio', min: -0.3, max: 0.3, step: 0.02, fmt: (v) => (v > 0 ? '+' : '') + pt(v, 2) },
      { key: 'moistureBias', label: 'Clima mais húmido / seco', min: -0.3, max: 0.3, step: 0.02, fmt: (v) => (v > 0 ? '+' : '') + pt(v, 2) },
    ],
  },
  {
    title: 'Posições iniciais', open: true, sliders: [
      { key: 'autoScale', kind: 'check', label: 'Tamanho do mundo automático', min: 0, max: 1, step: 1, help: 'O número de províncias, de células e o tamanho do mundo passam a vir de jogadores × províncias por jogador ÷ território inicial. Ignora os controlos de células e de províncias terrestres.' },
      { key: 'playerSlots', label: 'Jogadores / reinos', min: 6, max: 150, step: 1, help: 'Acima de 50, a geração demora 10–20 s e o equilíbrio entre posições fica mais solto.' },
      { key: 'startShare', label: 'Território inicial', min: 0.1, max: 0.6, step: 0.05, fmt: pct, help: 'Parte da terra que começa dentro de uma posição inicial (só com tamanho automático). O resto são terras livres.' },
      { key: 'reserveSlots', label: 'Posições de reserva', min: 0, max: 10, step: 1, help: 'Territórios intocáveis para quem entra a meio do jogo. O servidor tem de os proteger.' },
      { key: 'startProvinces', label: 'Províncias por jogador', min: 3, max: 12, step: 1 },
      { key: 'valueTolerance', label: 'Tolerância de valor', min: 0.02, max: 0.15, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, help: 'Diferença máxima entre a posição mais rica e a mais pobre.' },
      { key: 'rareShare', label: 'Recursos raros', min: 0.02, max: 0.15, step: 0.01, fmt: (v) => `${Math.round(v * 100)}% das províncias` },
    ],
  },
  {
    title: 'Zonas marítimas', sliders: [
      { key: 'coastalZoneCells', label: 'Tamanho das zonas costeiras', min: 15, max: 120, step: 5, fmt: (v) => `${v} células` },
      { key: 'oceanZoneCells', label: 'Tamanho das zonas oceânicas', min: 80, max: 500, step: 10, fmt: (v) => `${v} células` },
      { key: 'coastalBandHops', label: 'Largura da faixa costeira', min: 1, max: 5, step: 1, fmt: (v) => `${v} células` },
    ],
  },
  {
    title: 'Fronteiras', sliders: [
      { key: 'borderDetail', label: 'Detalhe das margens', min: 0, max: 1, step: 0.05, fmt: (v) => pt(v, 2) },
      { key: 'borderSmoothing', label: 'Passagens de suavização', min: 0, max: 3, step: 1 },
    ],
  },
];

function getVal(p: GenParams, key: SliderDef['key']): number {
  if (key === 'autoScale') return p.autoScale ? 1 : 0;
  if (key.startsWith('continentSizes.')) return p.continentSizes[Number(key.split('.')[1])];
  return p[key as NumKey];
}
function setVal(p: GenParams, key: SliderDef['key'], v: number) {
  if (key === 'autoScale') p.autoScale = v === 1;
  else if (key.startsWith('continentSizes.')) p.continentSizes[Number(key.split('.')[1])] = v;
  else (p as unknown as Record<string, number>)[key] = v;
}

/** Build the slider groups. `onCommit` fires when a slider is released. */
export function buildControls(root: HTMLElement, params: GenParams, onCommit: () => void) {
  root.innerHTML = '';
  const refreshers: (() => void)[] = [];
  for (const g of GROUPS) {
    const det = document.createElement('details');
    det.open = !!g.open;
    det.innerHTML = `<summary>${g.title}</summary>`;
    const box = document.createElement('div');
    box.className = 'params';
    for (const s of g.sliders) {
      const id = `p-${s.key.replace('.', '-')}`;
      const row = document.createElement('div');
      row.className = 'param';
      if (s.kind === 'check') {
        row.className = 'param param-check';
        row.innerHTML = `<label><input id="${id}" type="checkbox"> ${s.label}</label>` +
          (s.help ? `<span class="help">${s.help}</span>` : '');
        const cb = row.querySelector('input')!;
        const refresh = () => { cb.checked = getVal(params, s.key) === 1; };
        cb.addEventListener('change', () => { setVal(params, s.key, cb.checked ? 1 : 0); onCommit(); });
        refresh();
        refreshers.push(refresh);
        box.appendChild(row);
        continue;
      }
      row.innerHTML = `<label for="${id}">${s.label}</label><output for="${id}"></output>` +
        `<input id="${id}" type="range" min="${s.min}" max="${s.max}" step="${s.step}">` +
        (s.help ? `<span class="help">${s.help}</span>` : '');
      const input = row.querySelector('input')!;
      const out = row.querySelector('output')!;
      const show = () => { out.textContent = (s.fmt ?? String)(Number(input.value)); };
      const refresh = () => { input.value = String(getVal(params, s.key)); show(); };
      input.addEventListener('input', () => { setVal(params, s.key, Number(input.value)); show(); });
      input.addEventListener('change', onCommit);
      refresh();
      refreshers.push(refresh);
      box.appendChild(row);
    }
    det.appendChild(box);
    root.appendChild(det);
  }
  return () => refreshers.forEach((f) => f());
}
