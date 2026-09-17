import type { NextConfig } from "next";
import createMDX from "@next/mdx";

const nextConfig: NextConfig = {
  // Posts live as page.mdx files under src/app/writing/<slug>/.
  pageExtensions: ["ts", "tsx", "md", "mdx"],

  // The site has no server-side behaviour, so it exports to plain files and
  // can be hosted anywhere. `trailingSlash` makes each route a directory with
  // an index.html, which is what static hosts like GitHub Pages resolve.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

const withMDX = createMDX({});

export default withMDX(nextConfig);
