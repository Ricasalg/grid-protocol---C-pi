/* ============================================================================
   Scene dump — PASSO 0 diagnosis.

   The Arcade was reported as: a uniform cyan wash, one huge white blade in the
   middle of the screen, a building and machines that render as transparent
   wireframe, two small white squares in the distance, a stray grey box with a
   TERMINAL label, and text cut off at the left margin.

   Every one of those is a claim about what is on screen. This module answers
   the same claims with numbers: for every object in the Arcade's zone, what it
   is, how big, where it is, and exactly how its material is configured. It
   reads state; it changes nothing.

   The point is the project's own §6.3 lesson in reverse. There, a rendering bug
   was declared finished because it compiled. Here, a rendering bug is being
   diagnosed by reading source, from a distance, by someone who cannot see the
   screen. The dump is the bridge: it produces the evidence that settles it.

   SAFETY (§2): pure reads of objects already in memory. No filesystem, no
   network, no storage.
   ========================================================================== */

import * as THREE from 'three';

export interface MaterialRow {
  type: string;
  wireframe: unknown;
  transparent: unknown;
  opacity: unknown;
  depthWrite: unknown;
  blending: number;
  blendingName: string;
  emissiveIntensity: unknown;
  side: number;
  sideName: string;
  /** True for the additive materials — the ones that can wash the frame out. */
  additive: boolean;
  color: string;
}

export interface ObjectRow {
  name: string;
  geometry: string;
  size: string;
  position: string;
  material: MaterialRow | null;
}

/** How a row should be read: this is a summary of the whole Arcade subtree. */
export interface DumpRow extends ObjectRow {
  /** Children in the subtree, for orientation when reading the table. */
  childCount: number;
}

const BLEND_NAMES: Record<number, string> = {
  [THREE.NoBlending]: 'NoBlending',
  [THREE.NormalBlending]: 'NormalBlending',
  [THREE.AdditiveBlending]: 'AdditiveBlending',
  [THREE.MultiplyBlending]: 'MultiplyBlending',
  [THREE.SubtractiveBlending]: 'SubtractiveBlending',
};

const SIDE_NAMES: Record<number, string> = {
  [THREE.FrontSide]: 'FrontSide',
  [THREE.BackSide]: 'BackSide',
  [THREE.DoubleSide]: 'DoubleSide',
};

/** Geometry classes worth naming explicitly; anything else gets its type. */
function describeGeometry(geo: THREE.BufferGeometry | null): string {
  if (!geo) return '(none)';
  const p = (geo as unknown as { parameters?: Record<string, number> }).parameters;
  if (p) {
    const parts = Object.entries(p)
      .filter(([k]) => k !== 'widthSegments' && k !== 'heightSegments')
      .map(([k, v]) => `${k}=${round2(v)}`);
    if (parts.length) return `${geo.type}(${parts.join(', ')})`;
  }
  return geo.type;
}

/** Axis-aligned size in world units, which is what "how big is this" means. */
function worldSize(obj: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(obj);
  return box.getSize(new THREE.Vector3());
}

function round2(n: number): number {
  return Math.abs(n) < 0.01 ? 0 : Math.round(n * 100) / 100;
}

function fmtVec(v: THREE.Vector3): string {
  return `${round2(v.x)}, ${round2(v.y)}, ${round2(v.z)}`;
}

function readMaterial(raw: THREE.Material | THREE.Material[]): MaterialRow | null {
  if (Array.isArray(raw)) {
    // A multi-material mesh: report the first, and flag that it is multi so a
    // reader is not misled into thinking a wall is a single surface.
    if (!raw.length) return null;
    const first = readMaterial(raw[0]);
    return first ? { ...first, type: `${first.type} (+${raw.length - 1} more)` } : null;
  }

  const m = raw as THREE.Material & {
    wireframe?: boolean;
    transparent?: boolean;
    opacity?: number;
    depthWrite?: boolean;
    emissiveIntensity?: number;
  };

  const color = (m as THREE.MeshBasicMaterial).color;
  return {
    type: m.type,
    wireframe: m.wireframe ?? 'n/a',
    transparent: m.transparent,
    opacity: m.opacity ?? 'n/a',
    depthWrite: m.depthWrite,
    blending: m.blending,
    blendingName: BLEND_NAMES[m.blending] ?? String(m.blending),
    emissiveIntensity: m.emissiveIntensity ?? 'n/a (ShaderMaterial)',
    side: m.side,
    sideName: SIDE_NAMES[m.side] ?? String(m.side),
    additive: m.blending === THREE.AdditiveBlending,
    color: color ? `#${color.getHexString()}` : 'n/a',
  };
}

function readObject(obj: THREE.Object3D, childCount: number): DumpRow {
  const mesh = obj as THREE.Mesh;
  const geo = (mesh.geometry as THREE.BufferGeometry | undefined) ?? null;
  return {
    name: obj.name || obj.type,
    geometry: describeGeometry(geo),
    size: fmtVec(worldSize(obj)),
    position: fmtVec(obj.getWorldPosition(new THREE.Vector3())),
    material: readMaterial(mesh.material as THREE.Material),
    childCount,
  };
}

/* ---------------------------------------------------------------------------
   Table rendering
   --------------------------------------------------------------------------- */

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

/** Fixed-width table. Chosen over JSON because a column of numbers is easier
    to scan than a column of quoted keys when hunting for the one that's wrong. */
export function renderTable(rows: DumpRow[]): string {
  if (!rows.length) return '(no renderable objects in the zone)';

  const lines = [
    pad('NAME', 22) + pad('GEOMETRY', 40) + pad('SIZE m', 22) + pad('WORLD POS', 24),
    pad('', 22) + pad('MATERIAL', 40) + pad('BLEND / SIDE', 22) + pad('OP / DW', 12),
    '-'.repeat(120),
  ];

  for (const r of rows) {
    const m = r.material;
    lines.push(
      pad(r.name, 22) +
        pad(r.geometry, 40) +
        pad(r.size, 22) +
        pad(r.position, 24),
    );
    if (m) {
      lines.push(
        pad('', 22) +
          pad(`${m.type} ${m.color}`, 40) +
          pad(`${m.blendingName} / ${m.sideName}`, 22) +
          pad(`${m.opacity} / ${m.depthWrite}`, 12),
      );
      lines.push(
        pad('', 22) +
          pad(
            `wireframe=${m.wireframe}  transparent=${m.transparent}  emissiveIntensity=${m.emissiveIntensity}`,
            76,
          ),
      );
    } else {
      lines.push(pad('', 22) + pad('(no material — not a mesh)', 76));
    }
    if (r.childCount > 0) lines.push(pad('', 22) + pad(`└─ ${r.childCount} child object(s)`, 76));
  }

  return lines.join('\n');
}

/* ---------------------------------------------------------------------------
   The dump
   --------------------------------------------------------------------------- */

export interface SceneDump {
  rows: DumpRow[];
  table: string;
  /** Counts that answer the report directly, without reading the table. */
  summary: {
    meshes: number;
    additiveMeshes: number;
    transparentMeshes: number;
    /** Meshes whose material draws no surface: LineSegments, Points, etc. */
    nonMeshDrawables: number;
    /** Screen-area of the largest additive mesh, in m², from its world box. */
    largestAdditiveArea: number;
    largestAdditiveName: string;
  };
}

/**
 * Walk a subtree and describe every drawable in it.
 *
 * `root` is scanned in full; `centre`/`radius` only matter when a caller passes
 * a whole scene and wants the Arcade's neighbourhood rather than the world.
 */
export function dumpScene(root: THREE.Object3D): SceneDump {
  const rows: DumpRow[] = [];
  let additive = 0;
  let transparent = 0;
  let nonMesh = 0;
  let largestAdditiveArea = 0;
  let largestAdditiveName = '(none)';

  root.updateWorldMatrix(true, true);

  root.traverse((obj) => {
    const childCount = obj.children.length;
    const isMesh = (obj as THREE.Mesh).isMesh === true;

    if (!isMesh) {
      // Lines and points draw too, they just have no material of this shape.
      // Counting them separately stops "the building is invisible" from being
      // mistaken for "the building has no material".
      if ((obj as THREE.Line).isLine || (obj as THREE.Points).isPoints) {
        nonMesh++;
        rows.push(readObject(obj, childCount));
      } else if (childCount > 0) {
        rows.push(readObject(obj, childCount));
      }
      return;
    }

    const row = readObject(obj, childCount);
    rows.push(row);

    const m = row.material;
    if (!m) return;
    if (m.additive) {
      additive++;
      const size = worldSize(obj);
      const area = Math.max(0, size.x) * Math.max(0, size.y);
      if (area > largestAdditiveArea) {
        largestAdditiveArea = area;
        largestAdditiveName = row.name;
      }
    }
    if (m.transparent) transparent++;
  });

  return {
    rows,
    table: renderTable(rows),
    summary: {
      meshes: rows.filter((r) => r.material !== null && r.geometry !== '(none)').length,
      additiveMeshes: additive,
      transparentMeshes: transparent,
      nonMeshDrawables: nonMesh,
      largestAdditiveArea: Math.round(largestAdditiveArea * 100) / 100,
      largestAdditiveName,
    },
  };
}

/* ---------------------------------------------------------------------------
   On-screen panel
   --------------------------------------------------------------------------- */

const PANEL_ID = 'grid-scene-dump';

/**
 * Show the dump in a fixed panel as well as the console.
 *
 * The console is the record; the panel is for the case where the answer is
 * "which object is the white blade", which is a question about looking at
 * something rather than reading about it.
 */
export function showDumpPanel(text: string): void {
  document.getElementById(PANEL_ID)?.remove();

  const pre = document.createElement('pre');
  pre.id = PANEL_ID;
  pre.style.cssText =
    'position:fixed;left:8px;top:8px;bottom:8px;width:min(920px,72vw);z-index:99999;' +
    'margin:0;padding:12px;overflow:auto;background:rgba(3,6,10,.94);' +
    'border:1px solid #1d6f88;color:#4fe3ff;font:11px/1.4 ui-monospace,Consolas,monospace;' +
    'white-space:pre;border-radius:2px';

  const close = document.createElement('button');
  close.textContent = 'CLOSE';
  close.style.cssText =
    'position:sticky;top:0;float:right;margin-left:auto;background:#0b1620;color:#4fe3ff;' +
    'border:1px solid #1d6f88;font:11px ui-monospace,monospace;padding:4px 10px;cursor:pointer';
  close.addEventListener('click', () => pre.remove());

  pre.appendChild(close);
  pre.appendChild(document.createTextNode(text));

  document.body.appendChild(pre);
}