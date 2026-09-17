import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Emscripten uses instantiateStreaming, which refuses anything that is
        // not served as application/wasm and silently falls back to the slower
        // arrayBuffer path. Setting the type explicitly keeps the fast path.
        //
        // These filenames are not content-hashed, so a day of caching plus
        // revalidation is the right trade: fast repeat visits, but a codec
        // upgrade still reaches users without a hard purge.
        source: "/codecs/:file*.wasm",
        headers: [
          { key: "Content-Type", value: "application/wasm" },
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
