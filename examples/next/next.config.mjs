/** @type {import('next').NextConfig} */
const nextConfig = {
  // The example imports the package from this repo's build (`../../dist`).
  experimental: {
    externalDir: true,
    serverComponentsExternalPackages: ["@electric-sql/pglite"],
  },
};

export default nextConfig;
