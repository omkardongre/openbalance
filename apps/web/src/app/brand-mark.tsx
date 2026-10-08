import Image from "next/image";
import Link from "next/link";

/** Logo and name, linking home. The SVG is served as-is; it needs no raster optimization. */
export function BrandMark() {
  return (
    <Link className="brand" href="/">
      <Image src="/openbalance-icon.svg" alt="" width={32} height={32} unoptimized />
      OpenBalance
    </Link>
  );
}
