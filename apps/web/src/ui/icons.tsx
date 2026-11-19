interface P {
  size?: number
  className?: string
  strokeWidth?: number
  style?: React.CSSProperties
}

const base = (size = 18, sw = 1.8): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: sw,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const IconScissors = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12" />
  </svg>
)

export const IconGrid = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
)

export const IconFolder = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
  </svg>
)

export const IconFrame = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <rect x="7" y="7" width="10" height="10" rx="1" strokeDasharray="2 2.5" />
  </svg>
)

export const IconUpload = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <path d="M17 8l-5-5-5 5M12 3v12" />
  </svg>
)

export const IconPlay = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style} fill="currentColor" stroke="none">
    <path d="M7 4.5v15l13-7.5z" />
  </svg>
)

export const IconPause = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style} fill="currentColor" stroke="none">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
)

export const IconSparkle = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  </svg>
)

export const IconCheck = ({ size, className, style }: P) => (
  <svg {...base(size, 2.5)} className={className} style={style}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

export const IconX = ({ size, className, style }: P) => (
  <svg {...base(size, 2)} className={className} style={style}>
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
)

export const IconChevronRight = ({ size, className, style }: P) => (
  <svg {...base(size, 2)} className={className} style={style}>
    <path d="M9 18l6-6-6-6" />
  </svg>
)

export const IconChevronLeft = ({ size, className, style }: P) => (
  <svg {...base(size, 2)} className={className} style={style}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
)

export const IconDownload = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
    <path d="M7 10l5 5 5-5M12 15V3" />
  </svg>
)

export const IconRefresh = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M21 12a9 9 0 11-3.5-7.1" />
    <path d="M21 3v6h-6" />
  </svg>
)

export const IconTrash = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
  </svg>
)

export const IconEdit = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
  </svg>
)

export const IconFilm = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M2 12h20M2 8h5M2 16h5M17 8h5M17 16h5" />
  </svg>
)

export const IconClock = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

export const IconLayers = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M12 2L2 7l10 5 10-5-10-5z" />
    <path d="M2 12l10 5 10-5M2 17l10 5 10-5" />
  </svg>
)

export const IconUndo = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M3 7v6h6" />
    <path d="M3.5 13a9 9 0 103-7.7L3 8" />
  </svg>
)

export const IconSend = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
  </svg>
)

export const IconWand = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M15 4V2M15 10V8M11.5 6H9.5M20.5 6h-2" />
    <path d="M3 21L17 7l-2-2L1 19z" />
  </svg>
)

export const IconImage = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
)

export const IconLink = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7" />
  </svg>
)

export const IconAlert = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16.5v.5" />
  </svg>
)

export const IconLoader = ({ size = 18, className, style }: P) => (
  <svg {...base(size, 2)} className={`spin ${className ?? ''}`} style={style}>
    <path d="M21 12a9 9 0 11-6.2-8.56" />
  </svg>
)

export const IconPlus = ({ size, className, style }: P) => (
  <svg {...base(size, 2)} className={className} style={style}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconTarget = ({ size, className, style }: P) => (
  <svg {...base(size)}  className={className} style={style}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
  </svg>
)

export const IconChevronDown = ({ size, className, style }: P) => (
  <svg {...base(size, 2)} className={className} style={style}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)
