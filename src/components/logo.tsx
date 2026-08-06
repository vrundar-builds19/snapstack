export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="bx-logo-lockup" aria-label="SnapStack">
      <img className="bx-logo-mark" src="icon.svg" alt="" aria-hidden="true" />
      {!compact && <span className="bx-logo-type">snapstack</span>}
    </div>
  );
}
