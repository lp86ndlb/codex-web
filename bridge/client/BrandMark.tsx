/** Shared vector identity; stays sharp at every browser scale. */
export function BrandMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img className={`brand-mark ${className}`} src="/brand-symbol.svg?v=3" width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}
