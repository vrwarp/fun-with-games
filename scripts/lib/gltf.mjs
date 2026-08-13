/**
 * A tiny glTF 2.0 writer — enough to emit static, flat-shaded meshes.
 *
 * Deliberately dependency-free. An agent asked to "make a placeholder crate"
 * should be able to do it with `node scripts/generate-assets.mjs` and no
 * install step, no Blender, and no network. The output goes through exactly
 * the same loader path as downloaded art, so the pipeline is tested by the
 * assets it generates.
 *
 * Scope: positions, flat normals, indices, one PBR material. Skinning,
 * animation, morph targets and textures are out — reach for real DCC tooling
 * (or a downloaded asset) when you need those.
 */

/**
 * Builds an axis-aligned box as 24 vertices / 36 indices.
 *
 * Four vertices per face rather than eight shared corners: shared corners
 * would have to average their normals, which rounds off the edges and ruins
 * the faceted look these placeholders are going for.
 */
export function box({ center = [0, 0, 0], size = [1, 1, 1] } = {}) {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;

  const faces = [
    // normal, then the four corners in counter-clockwise winding.
    {
      n: [0, 0, 1],
      v: [
        [-hx, -hy, hz],
        [hx, -hy, hz],
        [hx, hy, hz],
        [-hx, hy, hz],
      ],
    },
    {
      n: [0, 0, -1],
      v: [
        [hx, -hy, -hz],
        [-hx, -hy, -hz],
        [-hx, hy, -hz],
        [hx, hy, -hz],
      ],
    },
    {
      n: [1, 0, 0],
      v: [
        [hx, -hy, hz],
        [hx, -hy, -hz],
        [hx, hy, -hz],
        [hx, hy, hz],
      ],
    },
    {
      n: [-1, 0, 0],
      v: [
        [-hx, -hy, -hz],
        [-hx, -hy, hz],
        [-hx, hy, hz],
        [-hx, hy, -hz],
      ],
    },
    {
      n: [0, 1, 0],
      v: [
        [-hx, hy, hz],
        [hx, hy, hz],
        [hx, hy, -hz],
        [-hx, hy, -hz],
      ],
    },
    {
      n: [0, -1, 0],
      v: [
        [-hx, -hy, -hz],
        [hx, -hy, -hz],
        [hx, -hy, hz],
        [-hx, -hy, hz],
      ],
    },
  ];

  const positions = [];
  const normals = [];
  const indices = [];

  for (const face of faces) {
    const base = positions.length / 3;
    for (const [x, y, z] of face.v) {
      positions.push(x + cx, y + cy, z + cz);
      normals.push(...face.n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return { positions, normals, indices };
}

/** Concatenates parts into one mesh, re-basing each part's indices. */
export function merge(parts) {
  const positions = [];
  const normals = [];
  const indices = [];

  for (const part of parts) {
    const offset = positions.length / 3;
    positions.push(...part.positions);
    normals.push(...part.normals);
    for (const index of part.indices) indices.push(index + offset);
  }

  return { positions, normals, indices };
}

/** Scales a mesh about the origin, in place-safe fashion. */
export function scaleMesh(mesh, factor) {
  return {
    positions: mesh.positions.map((value) => value * factor),
    normals: mesh.normals,
    indices: mesh.indices,
  };
}

function align4(value) {
  return (value + 3) & ~3;
}

/**
 * Serializes a mesh to a self-contained `.gltf` document.
 *
 * The binary buffer is embedded as a base64 data URI rather than a side-car
 * `.bin`, so a generated asset is exactly one file to copy, commit or serve.
 */
export function toGltf(
  mesh,
  {
    name = 'mesh',
    baseColor = [0.6, 0.65, 0.8, 1],
    metallic = 0.05,
    roughness = 0.75,
    generator = 'fun-with-games/scripts/generate-assets',
  } = {},
) {
  const positions = Float32Array.from(mesh.positions);
  const normals = Float32Array.from(mesh.normals);
  const indices = Uint16Array.from(mesh.indices);

  if (mesh.positions.length / 3 > 65535) {
    throw new Error(`${name}: more than 65535 vertices; switch indices to UNSIGNED_INT`);
  }

  const positionBytes = positions.byteLength;
  const normalBytes = normals.byteLength;
  const indexBytes = indices.byteLength;

  const positionOffset = 0;
  const normalOffset = align4(positionOffset + positionBytes);
  const indexOffset = align4(normalOffset + normalBytes);
  const totalBytes = align4(indexOffset + indexBytes);

  const buffer = Buffer.alloc(totalBytes);
  Buffer.from(positions.buffer, positions.byteOffset, positionBytes).copy(buffer, positionOffset);
  Buffer.from(normals.buffer, normals.byteOffset, normalBytes).copy(buffer, normalOffset);
  Buffer.from(indices.buffer, indices.byteOffset, indexBytes).copy(buffer, indexOffset);

  // glTF requires min/max on the POSITION accessor; viewers use it for
  // bounding boxes and frustum culling.
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }

  return {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [
      {
        name,
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
      },
    ],
    materials: [
      {
        name: `${name}-material`,
        pbrMetallicRoughness: {
          baseColorFactor: baseColor,
          metallicFactor: metallic,
          roughnessFactor: roughness,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: positions.length / 3,
        type: 'VEC3',
        min,
        max,
      },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      {
        bufferView: 2,
        componentType: 5123 /* UNSIGNED_SHORT */,
        count: indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: positionOffset, byteLength: positionBytes, target: 34962 },
      { buffer: 0, byteOffset: normalOffset, byteLength: normalBytes, target: 34962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes, target: 34963 },
    ],
    buffers: [
      {
        byteLength: totalBytes,
        uri: `data:application/octet-stream;base64,${buffer.toString('base64')}`,
      },
    ],
  };
}
