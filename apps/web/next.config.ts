import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  reactCompiler: false,
  transpilePackages: ["@logiplan/contracts", "@logiplan/domain", "@logiplan/ai"],
};

export default nextConfig;
