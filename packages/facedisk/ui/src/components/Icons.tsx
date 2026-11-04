// Small inline stroke icons (no icon-font dependency), sized via currentColor.

type IconProps = { size?: number; className?: string };

export function FolderOpenIcon({ size = 18, className }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1" />
      <path d="M3 8v9a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4l1.7-5.1A1 1 0 0 0 21 11H7.2a2 2 0 0 0-1.9 1.4L3 19" />
    </svg>
  );
}
