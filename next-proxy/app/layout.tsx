export const metadata = { title: 'AI Proxy Demo' }
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="zh"><body style={{ fontFamily: 'system-ui', maxWidth: 720, margin: '40px auto' }}>{children}</body></html>
}
