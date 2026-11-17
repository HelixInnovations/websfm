// LandXML 1.2 TIN surface writer — the surface format civil design software imports
// (Civil 3D, 12d, Trimble Business Center, Magnet). Pure, no Vue/Pinia/OPFS/DOM.
//
//   for (const part of tinToLandXmlParts(tin, meta)) …   // text in parts, for big TINs
//   tinToLandXml(tin, meta) → string
//
// tin: tin.js { vertices, triangles }, coordinates in a projected CRS in metres.
// meta: {
//   name          the surface's name ("Survey 2026-11-17")
//   description?  free text, written as the surface's desc
//   epsg?         horizontal CRS code number (2193) → CoordinateSystem epsgCode
//   crsName?      its name ("NZGD2000 / New Zealand Transverse Mercator 2000")
//   verticalDatum?  the heights' datum as text ("NZVD2016") → CoordinateSystem verticalDatum
//   application?  { name, version } → Application (default WebSfM)
//   date?         a Date for the file's date/time attributes (default now)
//   precision?    decimals for coordinates (default 4: 0.1 mm)
// }
//
// What it writes, and nothing more: one <Surface> with <Definition surfType="TIN">,
// its <Pnts> (each <P id> as "northing easting elevation", LandXML's order) and
// <Faces> (each <F> three point ids, 1-based, counter-clockwise in east/north seen from
// above). No breaklines, boundaries or watermarks are claimed, because none exist: a
// TIN from a DEM has none. Units are metric only; a CRS in feet is refused rather than
// labelled wrongly.

const NS = 'http://www.landxml.org/schema/LandXML-1.2'
const PART_LINES = 20000

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])

function fixed(v, precision) {
  if (!Number.isFinite(v)) throw new Error(`LandXML: non-finite coordinate (${v})`)
  let s = v.toFixed(precision)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

const pad2 = (n) => String(n).padStart(2, '0')

export function* tinToLandXmlParts(tin, meta = {}) {
  const { vertices: v, triangles: t } = tin
  if (!t.length) throw new Error('LandXML: the surface has no triangles')
  if (meta.unit && meta.unit !== 'metre') throw new Error('LandXML: only metric surfaces are written')
  const precision = meta.precision ?? 4
  const date = meta.date ?? new Date()
  const app = meta.application ?? { name: 'WebSfM', version: '' }

  // Only the vertices some triangle uses are written, renumbered from 1.
  const used = new Int32Array(v.length / 3).fill(0)
  for (let i = 0; i < t.length; i++) used[t[i]] = 1
  let next = 0
  for (let i = 0; i < used.length; i++) used[i] = used[i] ? ++next : 0

  let zMin = Infinity,
    zMax = -Infinity,
    area2 = 0,
    area3 = 0
  for (let i = 0; i < used.length; i++)
    if (used[i]) {
      const z = v[3 * i + 2]
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
    }
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i],
      b = 3 * t[i + 1],
      c = 3 * t[i + 2]
    const ux = v[b] - v[a],
      uy = v[b + 1] - v[a + 1],
      uz = v[b + 2] - v[a + 2]
    const wx = v[c] - v[a],
      wy = v[c + 1] - v[a + 1],
      wz = v[c + 2] - v[a + 2]
    area2 += Math.abs(ux * wy - uy * wx) / 2
    area3 += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2
  }

  const cs = [
    meta.crsName ? ` name="${esc(meta.crsName)}"` : '',
    meta.epsg ? ` epsgCode="${esc(meta.epsg)}"` : '',
    meta.verticalDatum ? ` verticalDatum="${esc(meta.verticalDatum)}"` : '',
  ].join('')
  yield '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<LandXML xmlns="${NS}" version="1.2" date="${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}" time="${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}">\n` +
    '  <Units>\n' +
    '    <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="milliBars" diameterUnit="millimeter" angularUnit="decimal degrees" directionUnit="decimal degrees"/>\n' +
    '  </Units>\n' +
    (cs ? `  <CoordinateSystem${cs}/>\n` : '') +
    `  <Application name="${esc(app.name)}"${app.version ? ` version="${esc(app.version)}"` : ''}/>\n` +
    '  <Surfaces>\n' +
    `    <Surface name="${esc(meta.name ?? 'Surface')}"${meta.description ? ` desc="${esc(meta.description)}"` : ''}>\n` +
    `      <Definition surfType="TIN" area2DSurf="${fixed(area2, 3)}" area3DSurf="${fixed(area3, 3)}" elevMin="${fixed(zMin, precision)}" elevMax="${fixed(zMax, precision)}">\n` +
    '        <Pnts>\n'

  let buf = []
  for (let i = 0; i < used.length; i++) {
    if (!used[i]) continue
    buf.push(
      `          <P id="${used[i]}">${fixed(v[3 * i + 1], precision)} ${fixed(v[3 * i], precision)} ${fixed(v[3 * i + 2], precision)}</P>`,
    )
    if (buf.length >= PART_LINES) {
      yield buf.join('\n') + '\n'
      buf = []
    }
  }
  if (buf.length) yield buf.join('\n') + '\n'
  yield '        </Pnts>\n        <Faces>\n'
  buf = []
  for (let i = 0; i < t.length; i += 3) {
    buf.push(`          <F>${used[t[i]]} ${used[t[i + 1]]} ${used[t[i + 2]]}</F>`)
    if (buf.length >= PART_LINES) {
      yield buf.join('\n') + '\n'
      buf = []
    }
  }
  if (buf.length) yield buf.join('\n') + '\n'
  yield '        </Faces>\n      </Definition>\n    </Surface>\n  </Surfaces>\n</LandXML>\n'
}

export function tinToLandXml(tin, meta = {}) {
  let s = ''
  for (const part of tinToLandXmlParts(tin, meta)) s += part
  return s
}
