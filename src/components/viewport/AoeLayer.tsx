import React from 'react';
import { useCombatStore } from '../../stores/combatStore';

/**
 * AoeLayer — highlights the affected tiles of the current AoE preview on the
 * battlemap floor (under tokens). [COMBAT-003]
 *
 * Reads combatStore.aoePreview (set by recordAoePreview from engine-computed
 * affectedTiles, or by setAoePreview for a local template). Tiles are MCP
 * coords; viz coord = mcp - 10, centered with +0.5 (matches the clicked-tile
 * highlight convention in GridSystem).
 */
export const AoeLayer: React.FC = () => {
  const aoePreview = useCombatStore((s) => s.aoePreview);

  if (!aoePreview || aoePreview.tiles.length === 0) return null;

  const { tiles, color } = aoePreview;

  return (
    <group>
      {tiles.map((t) => {
        const vizX = t.x - 10 + 0.5;
        const vizZ = t.y - 10 + 0.5;
        return (
          <mesh
            key={`aoe-${t.x}-${t.y}`}
            position={[vizX, 0.08, vizZ]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[0.95, 0.95]} />
            <meshBasicMaterial color={color} transparent opacity={0.35} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
};
