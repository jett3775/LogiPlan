import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  reactCompiler: false,
  transpilePackages: ["@logiplan/contracts", "@logiplan/domain"],
};

export default nextConfig;
