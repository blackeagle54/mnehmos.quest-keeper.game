import React, { useMemo, useState, useEffect } from 'react';
import { Html, Line, Edges, Grid, Text } from '@react-three/drei';
import { ThreeEvent, useThree } from '@react-three/fiber';
import { useCombatStore } from '../../stores/combatStore';
import { isTileBlocked, getElevationAt, calculateDistance3D } from '../../utils/gridHelpers';
import { useTheme } from '../../context/ThemeContext';

// Theme-specific color palettes for the 3D grid
const GRID_THEMES = {
  terminal: {
    cellColor: '#003300',
    sectionColor: '#00ff41',
    ground: '#0a0a0a',
    highlight: '#00ff41',
    highlightBlocked: '#ff0000',
    compass: '#00ff41',
    compassNorth: '#ff4444',
  },
  fantasy: {
    cellColor: '#2c1810',
    sectionColor: '#8b4513',
    ground: '#1e1610',
    highlight: '#d4af37',
    highlightBlocked: '#8b0000',
    compass: '#d4af37',
    compassNorth: '#8b0000',
  },
  light: {
    cellColor: '#e5e5e5',
    sectionColor: '#da7756',
    ground: '#f0f0f0',
    highlight: '#da7756',
    highlightBlocked: '#dc2626',
    compass: '#da7756',
    compassNorth: '#dc2626',
  },
};

export const GridSystem: React.FC = () => {
  const { theme } = useTheme();
  // Safe fallback to 'terminal' if theme is undefined or invalid
  const activeTheme = theme && GRID_THEMES[theme] ? theme : 'terminal';
  const colors = GRID_THEMES[activeTheme];
  
  const entities = useCombatStore((state) => state.entities);
  const terrain = useCombatStore((state) => state.terrain);
  const setClickedTileCoord = useCombatStore((state) => state.setClickedTileCoord);
  const selectedEntityId = useCombatStore((state) => state.selectedEntityId);
  const requestMove = useCombatStore((state) => state.requestMove);
  const clickedTileCoord = useCombatStore((state) => state.clickedTileCoord);
  
  // Calculate dynamic bounds from all entities and terrain
  const bounds = useMemo(() => {
    let minX = 0, maxX = 20, minZ = 0, maxZ = 20;
    
    // Check entity positions (in MCP coords)
    entities.forEach(entity => {
      const mcpX = entity.position.x + 10; // Convert viz to MCP
      const mcpZ = entity.position.z + 10;
      minX = Math.min(minX, mcpX);
      maxX = Math.max(maxX, mcpX);
      minZ = Math.min(minZ, mcpZ);
      maxZ = Math.max(maxZ, mcpZ);
    });
    
    // Check terrain positions (in MCP coords)
    terrain.forEach(t => {
      const mcpX = t.position.x + 10; // Convert viz to MCP
      const mcpZ = t.position.z + 10;
      minX = Math.min(minX, mcpX);
      maxX = Math.max(maxX, mcpX);
      minZ = Math.min(minZ, mcpZ);
      maxZ = Math.max(maxZ, mcpZ);
    });
    
    // Add padding and round to nice numbers
    const padding = 5;
    minX = Math.floor((minX - padding) / 5) * 5;
    maxX = Math.ceil((maxX + padding) / 5) * 5;
    minZ = Math.floor((minZ - padding) / 5) * 5;
    maxZ = Math.ceil((maxZ + padding) / 5) * 5;
    
    // Calculate the center offset for visualization
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    const rangeX = maxX - minX;
    const rangeZ = maxZ - minZ;
    const gridSize = Math.max(rangeX, rangeZ, 20);
    
    return { minX, maxX, minZ, maxZ, centerX, centerZ, gridSize };
  }, [entities, terrain]);
  
  const gridSize = Math.max(bounds.gridSize, 100);
  const labels: React.ReactElement[] = [];
  
  // Helper to convert MCP coord to visualizer coord  
  const toViz = (mcpCoord: number) => mcpCoord - 10;
  
  const { controls } = useThree() as any;
  const [compassPos, setCompassPos] = useState<{x: number, z: number} | null>(null);
  const [compassRotation, setCompassRotation] = useState(0);
  const [isDraggingCompass, setIsDraggingCompass] = useState(false);
  const [isRotatingCompass, setIsRotatingCompass] = useState(false);

  // Disable OrbitControls/Pan when dragging/rotating compass
  useEffect(() => {
    if (controls) {
      controls.enabled = !isDraggingCompass && !isRotatingCompass;
    }
  }, [controls, isDraggingCompass, isRotatingCompass]);

  const compassPosition: [number, number, number] = useMemo(() => {
    if (compassPos) return [compassPos.x, 1.5, compassPos.z];
    return [toViz(bounds.maxX - 5), 1.5, toViz(bounds.minZ + 5)];
  }, [compassPos, bounds]);

  const measureMode = useCombatStore((state) => state.measureMode);
  // REMOVED: Numbered axis labels per user request
  // The grid lines themselves provide visual reference
  // Compass rose provides orientation
  const measureStart = useCombatStore((state) => state.measureStart);
  const measureEnd = useCombatStore((state) => state.measureEnd);
  const cursorPosition = useCombatStore((state) => state.cursorPosition);
  const setMeasureStart = useCombatStore((state) => state.setMeasureStart);
  const setMeasureEnd = useCombatStore((state) => state.setMeasureEnd);
  const setCursorPosition = useCombatStore((state) => state.setCursorPosition);

  // Helper to calculate Y at a specific grid coordinate (Viz coords)
  const calcElevation = (vizX: number, vizZ: number) => {
    // Viz coords -> MCP coords
    const mcpX = vizX + 10;
    const mcpZ = vizZ + 10;
    // getElevationAt returns Y height (Viz Y)
    return getElevationAt(mcpX, mcpZ, terrain, entities);
  };

  const onPlaneClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const vizX = Math.floor(e.point.x);
    const vizZ = Math.floor(e.point.z);
    
    if (measureMode) {
      if (!measureStart) {
        setMeasureStart({ x: vizX, y: vizZ }); 
      } else if (!measureEnd) {
        setMeasureEnd({ x: vizX, y: vizZ });
      } else {
        setMeasureStart({ x: vizX, y: vizZ });
        setMeasureEnd(null);
      }
    } else {
      const mcpX = vizX + 10;
      const mcpZ = vizZ + 10;
      if (selectedEntityId) {
        // Click-to-move: send the selected token to this tile (engine validates). [COMBAT-002]
        requestMove(selectedEntityId, mcpX, mcpZ);
        setClickedTileCoord({ x: mcpX, y: mcpZ });
      } else if (clickedTileCoord && clickedTileCoord.x === mcpX && clickedTileCoord.y === mcpZ) {
        setClickedTileCoord(null);
      } else {
        setClickedTileCoord({ x: mcpX, y: mcpZ });
      }
    }
  };

  const onPointerMove = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    
    // Handle Compass Dragging with Snap-to-Grid
    if (isDraggingCompass) {
      setCompassPos({ 
        x: Math.round(e.point.x), 
        z: Math.round(e.point.z) 
      });
      return;
    }
    
    // Handle Compass Rotation
    if (isRotatingCompass) {
        const cx = compassPosition[0];
        const cz = compassPosition[2];
        const dx = e.point.x - cx;
        const dz = e.point.z - cz;
        // atan2(x, z) gives rotation relative to Z axis
        let angle = Math.atan2(dx, dz);
        // Add PI to flip 180 if needed (Trial: North is -Z)
        // atan2(0, -1) = PI. We want 0 if North. 
        // Actually, if we just set rotation to angle, it will follow mouse.
        setCompassRotation(angle + Math.PI); 
        return;
    }
    
    const vizX = Math.floor(e.point.x);
    const vizZ = Math.floor(e.point.z);
    setCursorPosition({ x: vizX, y: vizZ });
  };

  const onPointerUp = (e: ThreeEvent<MouseEvent>) => {
    if (isDraggingCompass || isRotatingCompass) {
      e.stopPropagation();
      setIsDraggingCompass(false);
      setIsRotatingCompass(false);
    }
  };

  return (
    <group>
      {/* Background Plane */}
      <mesh 
        rotation={[-Math.PI / 2, 0, 0]} 
        position={[0, -0.1, 0]} 
        receiveShadow
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onPlaneClick}
      >
        <planeGeometry args={[gridSize, gridSize]} />
        <meshStandardMaterial 
          color={colors.ground}
          roughness={1} 
          metalness={0}
        />
      </mesh>
      
      {/* Infinite Grid from Drei */}
      <Grid 
        renderOrder={-1}
        position={[0, -0.05, 0]}
        args={[gridSize, gridSize]} 
        cellSize={1} 
        cellThickness={1} 
        cellColor={colors.cellColor} 
        sectionSize={5} 
        sectionThickness={1.5} 
        sectionColor={colors.sectionColor} 
        fadeDistance={100} 
        fadeStrength={1} 
        infiniteGrid 
      />
      
      {labels}
      
      {/* 3D Compass Asset - Pocket Compass Style */}
      <group 
        position={compassPosition}
        onPointerOver={() => document.body.style.cursor = 'grab'}
        onPointerOut={() => document.body.style.cursor = 'default'}
      >
        {/* Shadow/Grounding - Stays Fixed or follows Pos */}
        <mesh position={[0, -0.3, 0]} rotation={[-Math.PI/2, 0, 0]}>
          <circleGeometry args={[2.2, 32]} />
          <meshBasicMaterial color="#000" opacity={0.4} transparent />
        </mesh>

        {/* ROTATABLE CASE GROUP */}
        <group rotation={[0, compassRotation, 0]}>
          
          {/* Compass Case (Base) - Drag Handle */}
          <mesh 
            position={[0, -0.1, 0]} 
            onPointerDown={(e) => {
              e.stopPropagation();
              setIsDraggingCompass(true);
            }}
          >
            <cylinderGeometry args={[2, 2, 0.2, 32]} />
            <meshStandardMaterial color={colors.compass} metalness={0.7} roughness={0.2} />
          </mesh>

          {/* Compass Face (Background) - Drag Handle */}
          <mesh 
            position={[0, 0.01, 0]} 
            rotation={[-Math.PI/2, 0, 0]}
            onPointerDown={(e) => {
              e.stopPropagation();
              setIsDraggingCompass(true);
            }}
          >
            <circleGeometry args={[1.8, 32]} />
            <meshStandardMaterial color={colors.ground} roughness={0.9} />
          </mesh>

          {/* Compass Rim (Wall) - ROTATION HANDLE */}
          <mesh 
            position={[0, 0.1, 0]} 
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerDown={(e) => {
               e.stopPropagation();
               setIsRotatingCompass(true);
            }}
            onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'ew-resize'; }}
            onPointerOut={(e) => { e.stopPropagation(); document.body.style.cursor = 'grab'; }}
          >
            <torusGeometry args={[2, 0.1, 16, 64]} />
            <meshStandardMaterial color={colors.compass} metalness={0.7} roughness={0.2} />
          </mesh>

          {/* Cardinal Direction Labels - Attached to Case */}
          <Text 
            position={[0, 0.05, -1.5]} 
            rotation={[-Math.PI / 2, 0, 0]} 
            fontSize={0.6} 
            color={colors.compassNorth}
            anchorX="center" 
            anchorY="middle"
            outlineWidth={0.02}
            outlineColor={colors.ground}
          >
            N
          </Text>
          <Text 
            position={[1.5, 0.05, 0]} 
            rotation={[-Math.PI / 2, 0, 0]} 
            fontSize={0.4} 
            color={colors.compass}
            anchorX="center" 
            anchorY="middle"
          >
            E
          </Text>
          <Text 
            position={[0, 0.05, 1.5]} 
            rotation={[-Math.PI / 2, 0, 0]} 
            fontSize={0.4} 
            color={colors.compass}
            anchorX="center" 
            anchorY="middle"
          >
            S
          </Text>
          <Text 
            position={[-1.5, 0.05, 0]} 
            rotation={[-Math.PI / 2, 0, 0]} 
            fontSize={0.4} 
            color={colors.compass}
            anchorX="center" 
            anchorY="middle"
          >
            W
          </Text>

          {/* Ticks/Markings */}
          {Array.from({ length: 12 }).map((_, i) => (
            <mesh 
              key={i} 
              rotation={[0, (i * Math.PI) / 6, 0]} 
              position={[Math.sin((i * Math.PI) / 6) * 1.6, 0.02, Math.cos((i * Math.PI) / 6) * 1.6]}
            >
              <boxGeometry args={[0.05, 0.01, 0.2]} />
              <meshStandardMaterial color={i % 3 === 0 ? colors.compass : colors.compassNorth} opacity={0.5} transparent />
            </mesh>
          ))}
        </group>

        {/* FIXED NEEDLE GROUP - Always points to 'True North' (World -Z) */}
        <group position={[0, 0.2, 0]}>
          {/* Central Pivot */}
          <mesh>
            <sphereGeometry args={[0.15, 16, 16]} />
            <meshStandardMaterial color={colors.compass} metalness={0.9} roughness={0.1} />
          </mesh>
          
          {/* North Needle (Red) - Points to Z- */}
          <mesh position={[0, 0, -0.6]} rotation={[-Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.15, 1.2, 4]} />
            <meshStandardMaterial color={colors.compassNorth} emissive={colors.compassNorth} emissiveIntensity={0.6} />
          </mesh>
          
          {/* South Needle (Theme Color) */}
          <mesh position={[0, 0, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.15, 1.2, 4]} />
            <meshStandardMaterial color={colors.compass} metalness={0.5} />
          </mesh>
        </group>
      </group>
      
      {/* Clicked Tile Indicator */}
      {clickedTileCoord && (
        <group position={[toViz(clickedTileCoord.x) + 0.5, calcElevation(toViz(clickedTileCoord.x), toViz(clickedTileCoord.y)) + 0.1, toViz(clickedTileCoord.y) + 0.5]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.3, 0.4, 32]} />
            <meshBasicMaterial color="#ffff00" opacity={0.8} transparent side={2} />
          </mesh>
          <Html position={[0, 1, 0]} center style={{ pointerEvents: 'none' }}>
            <div style={{ background: 'rgba(0,0,0,0.8)', color: '#ffff00', padding: '4px 8px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '12px', border: '1px solid #ffff00', whiteSpace: 'nowrap' }}>
              ({clickedTileCoord.x}, {clickedTileCoord.y})
            </div>
          </Html>
        </group>
      )}
      
      {/* Measurement Visualization */}
      {measureMode && measureStart && (
        <group>
          {(() => {
             // START POINT
             const startY = calcElevation(measureStart.x, measureStart.y);
             const startPos = { x: measureStart.x + 0.5, y: startY + 0.05, z: measureStart.y + 0.5 };
             
             // END POINT (Target)
             const target2D = measureEnd || cursorPosition;
             
             return (
               <>
                 {/* Start Marker */}
                 <mesh position={[startPos.x, startPos.y, startPos.z]} rotation={[-Math.PI/2, 0, 0]}>
                    <ringGeometry args={[0.2, 0.3, 16]} />
                    <meshBasicMaterial color="#00ffff" />
                 </mesh>
                 
                 {target2D && (() => {
                     const endY = calcElevation(target2D.x, target2D.y);
                     const endPos = { x: target2D.x + 0.5, y: endY + 0.05, z: target2D.y + 0.5 };
                     
                     // 3D Distance
                     const dist = calculateDistance3D(startPos, endPos);
                     const distFeet = Math.round(dist * 5 * 10) / 10;
                     
                     return (
                        <group>
                           <Line
                              points={[
                                [startPos.x, startPos.y + 0.1, startPos.z],
                                [endPos.x, endPos.y + 0.1, endPos.z]
                              ]}
                              color="#00ffff"
                              lineWidth={2}
                              dashed
                              dashScale={2}
                           />
                           {/* End Marker */}
                           <mesh position={[endPos.x, endPos.y, endPos.z]} rotation={[-Math.PI/2, 0, 0]}>
                             <ringGeometry args={[0.1, 0.2, 16]} />
                             <meshBasicMaterial color="#00ffff" />
                           </mesh>
                           {/* Label */}
                           <Html position={[(startPos.x + endPos.x)/2, (startPos.y + endPos.y)/2 + 0.5, (startPos.z + endPos.z)/2]} center>
                              <div style={{ background: 'rgba(0,0,0,0.8)', color: '#00ffff', padding: '2px 6px', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace', pointerEvents: 'none' }}>
                                {distFeet} ft
                              </div>
                           </Html>
                        </group>
                     );
                 })()}
               </>
             );
          })()}
        </group>
      )}

      {/* Hover Cursor Highlight */}
      {cursorPosition && (
        (() => {
          const mcpX = cursorPosition.x + 10;
          const mcpY = cursorPosition.y + 10;
          const isBlocked = isTileBlocked(mcpX, mcpY, entities, terrain);
          const color = isBlocked ? colors.highlightBlocked : colors.highlight;
          const y = calcElevation(cursorPosition.x, cursorPosition.y);
          
          return (
            <group position={[cursorPosition.x + 0.5, y + 0.05, cursorPosition.y + 0.5]}>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[0.9, 0.9]} />
                <meshBasicMaterial color={color} opacity={0.3} transparent />
                <Edges color={color} />
              </mesh>
            </group>
          );
        })()
      )}

      {/* Invisible plane for raycasting and shadows */}
      <mesh 
        rotation={[-Math.PI / 2, 0, 0]} 
        position={[0, 0, 0]} 
        receiveShadow 
        onClick={onPlaneClick}
        onPointerMove={onPointerMove}
      >
        <planeGeometry args={[gridSize, gridSize]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
};