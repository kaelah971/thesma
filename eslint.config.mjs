import next from "eslint-config-next";

const config = [
  {
    ignores: ["node_modules/**", ".next/**", "contracts/lib/**", "contracts/out/**", "contracts/cache/**", "contracts/broadcast/**"],
  },
  ...next,
];

export default config;
