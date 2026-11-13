// Stockpile materials and their loose bulk densities, for volume → tonnage in the
// Volume measurement. The same catalogue as the Stockpile app (Helix Innovations):
// typical mid-points for material sitting in a stockpile, not compacted in place,
// compiled from earthwork reference tables and supplier data. Moisture can add
// 10–20 % for aggregates and much more for mulches, so a tonnage is only as good as
// the density chosen; the result says which one it used.

/** @typedef {{ id: string, name: string, density: number, range: string, group: string }} Material */

/** @type {Material[]} density in t/m³ */
export const MATERIALS = [
  { id: 'crushed-rock', name: 'Crushed rock / road base', density: 1.6, range: '1.45–1.85', group: 'Aggregates' },
  { id: 'crusher-dust', name: 'Crusher dust / screenings', density: 1.7, range: '1.55–1.90', group: 'Aggregates' },
  { id: 'river-gravel', name: 'River gravel (rounded)', density: 1.6, range: '1.50–1.70', group: 'Aggregates' },
  { id: 'rail-ballast', name: 'Rail ballast', density: 1.55, range: '1.45–1.65', group: 'Aggregates' },
  {
    id: 'recycled-concrete',
    name: 'Recycled crushed concrete',
    density: 1.45,
    range: '1.30–1.60',
    group: 'Aggregates',
  },
  { id: 'rap', name: 'Reclaimed asphalt (RAP)', density: 1.55, range: '1.40–1.70', group: 'Aggregates' },
  { id: 'pebble', name: 'Decorative pebble', density: 1.55, range: '1.45–1.65', group: 'Aggregates' },
  { id: 'sand-dry', name: 'Sand (dry)', density: 1.5, range: '1.40–1.60', group: 'Sands and soils' },
  { id: 'sand-wet', name: 'Sand (damp / wet)', density: 1.8, range: '1.70–2.00', group: 'Sands and soils' },
  { id: 'topsoil', name: 'Topsoil (loose stockpile)', density: 1.3, range: '1.20–1.40', group: 'Sands and soils' },
  { id: 'fill', name: 'Fill dirt / subsoil', density: 1.6, range: '1.50–1.75', group: 'Sands and soils' },
  { id: 'clay', name: 'Clay (common)', density: 1.7, range: '1.60–1.85', group: 'Sands and soils' },
  { id: 'garden-mix', name: 'Garden / landscape mix', density: 1.0, range: '0.90–1.10', group: 'Sands and soils' },
  { id: 'wood-chip', name: 'Wood chip mulch', density: 0.3, range: '0.20–0.40', group: 'Green waste' },
  { id: 'bark', name: 'Bark mulch', density: 0.4, range: '0.35–0.50', group: 'Green waste' },
  { id: 'compost', name: 'Compost (screened)', density: 0.7, range: '0.50–0.80', group: 'Green waste' },
]

/** The catalogue in its groups, in order: [{ group, items: Material[] }]. */
export function materialGroups() {
  const groups = []
  for (const m of MATERIALS) {
    let g = groups.find((x) => x.group === m.group)
    if (!g) groups.push((g = { group: m.group, items: [] }))
    g.items.push(m)
  }
  return groups
}

export const materialById = (id) => MATERIALS.find((m) => m.id === id) ?? null

/**
 * A density as typed, in t/m³, or null when no stockpile could have it. Yards that
 * work in kg/m³ type 1600 for 1.6, so 100–3000 is read as kg/m³; anything else must
 * already be 0.1–3.0 t/m³. A comma decimal separator is accepted.
 * @returns {{ tm3: number, fromKg: boolean } | null}
 */
export function parseDensity(text) {
  const v = typeof text === 'number' ? text : Number(String(text ?? '').trim().replace(',', '.'))
  if (!Number.isFinite(v) || String(text ?? '').trim() === '') return null
  if (v >= 100 && v <= 3000) return { tm3: v / 1000, fromKg: true }
  if (v < 0.1 || v > 3.0) return null
  return { tm3: v, fromKg: false }
}

// Cubic metres in one cubic unit of each linear unit a DEM can be in.
const M_PER_UNIT = { m: 1, ft: 0.3048, 'US-ft': 1200 / 3937 }

/**
 * Tonnes of material for a volume measured in `horizontal² × vertical` units, at a
 * density in t/m³. null when either unit is not a length we can convert (model
 * units, degrees): a tonnage from a volume of unknown size would be a guess.
 */
export function tonnage(volume, density, { horizontal, vertical }) {
  const h = M_PER_UNIT[horizontal],
    v = M_PER_UNIT[vertical]
  if (!h || !v || !Number.isFinite(volume) || !(density > 0)) return null
  return volume * h * h * v * density
}
