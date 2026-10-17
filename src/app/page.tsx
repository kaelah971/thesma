export default function Home() {
  return (
    <main style={{ padding: 32, maxWidth: 720 }}>
      <h1>Thesma — S0 backend foundation (Shipped)</h1>
      <p>
        Thesma is an autonomous market for verified business outcomes. This slice is
        backend-first: no product UI, wallet flow, vault, agents, or Arc integration yet.
      </p>
      <ul>
        <li>
          <a href="/api/health">GET /api/health</a> — readiness
        </li>
        <li>GET /api/me — current session</li>
        <li>POST /api/workspaces — create organization workspace</li>
        <li>POST /api/partners — create Partner profile</li>
      </ul>
      <p>See README for setup, env vars, and what is explicitly NOT implemented.</p>
    </main>
  );
}
