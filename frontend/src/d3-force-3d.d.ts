declare module 'd3-force-3d' {
  export function forceCollide<NodeDatum = unknown>(
    radius?: number | ((node: NodeDatum) => number)
  ): {
    iterations: (n: number) => unknown
    strength: (v: number) => unknown
  }
  export function forceX<NodeDatum = unknown>(x?: number | ((node: NodeDatum) => number)): {
    strength: (v: number) => unknown
  }
  export function forceY<NodeDatum = unknown>(y?: number | ((node: NodeDatum) => number)): {
    strength: (v: number) => unknown
  }
}
