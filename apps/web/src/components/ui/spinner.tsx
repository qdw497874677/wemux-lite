import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Spinner 逐字对照 TailGrids（MIT, github.com/TailGrids）的 spinner 复刻。
 *
 * 上游的 Spinner 不是“转圈的图标”，而是三个手绘 SVG：
 * - default：24 段同心弧 + mask 组成的有进度环（percentage 决定弧长，配合 animate-spin）；
 * - dotted / dotted-round：由几十条带 opacity 渐变的点状路径拼出的加载环。
 * 三者的笔画色都直接写 var(--color-primary-500)，所以主题切换不需要额外 class。
 * 与上游的两点差异（有意保留）：label 生成 sr-only 文案、外层带 role="status"，
 * 让加载态对读屏可见。
 */

type PropsType = ComponentProps<'svg'> & {
  size?: number
  percentage?: number
}

export function DefaultSpinner({ size = 130, percentage = 80, ...props }: PropsType) {
  const strokeWidth = 10
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const progressOffset = circumference - (percentage / 100) * circumference
  const center = size / 2

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* Background Track Circle */}
      <mask id={`path-1-inside-1-${percentage}`} fill="white">
        <path
          d={`
            M ${size} ${center} 
            C ${size} ${size * 0.776} ${size * 0.776} ${size} ${center} ${size}
            C ${size * 0.224} ${size} 0 ${size * 0.776} 0 ${center}
            C 0 ${size * 0.224} ${size * 0.224} 0 ${center} 0
            C ${size * 0.776} 0 ${size} ${size * 0.224} ${size} ${center}
            Z
            M ${size * 0.0768} ${center}
            C ${size * 0.0768} ${size * 0.734} ${size * 0.266} ${size * 0.923} ${center} ${size * 0.923}
            C ${size * 0.734} ${size * 0.923} ${size * 0.923} ${size * 0.734} ${size * 0.923} ${center}
            C ${size * 0.923} ${size * 0.266} ${size * 0.734} ${size * 0.0768} ${center} ${size * 0.0768}
            C ${size * 0.266} ${size * 0.0768} ${size * 0.0768} ${size * 0.266} ${size * 0.0768} ${center}
            Z
          `}
        />
      </mask>
      <path
        d={`
            M ${size} ${center} 
            C ${size} ${size * 0.776} ${size * 0.776} ${size} ${center} ${size}
            C ${size * 0.224} ${size} 0 ${size * 0.776} 0 ${center}
            C 0 ${size * 0.224} ${size * 0.224} 0 ${center} 0
            C ${size * 0.776} 0 ${size} ${size * 0.224} ${size} ${center}
            Z
            M ${size * 0.0768} ${center}
            C ${size * 0.0768} ${size * 0.734} ${size * 0.266} ${size * 0.923} ${center} ${size * 0.923}
            C ${size * 0.734} ${size * 0.923} ${size * 0.923} ${size * 0.734} ${size * 0.923} ${center}
            C ${size * 0.923} ${size * 0.266} ${size * 0.734} ${size * 0.0768} ${center} ${size * 0.0768}
            C ${size * 0.266} ${size * 0.0768} ${size * 0.0768} ${size * 0.266} ${size * 0.0768} ${center}
            Z
          `}
        stroke="var(--border-color-base-100)"
        strokeWidth="20"
        mask={`url(#path-1-inside-1-${percentage})`}
      />

      {/* Progress Arc */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        stroke="var(--color-primary-500)"
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={progressOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${center} ${center})`}
        className="transition-all duration-700 ease-out"
      />
    </svg>
  )
}

export function DottedSpinner(props: ComponentProps<'svg'>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" {...props}>
      <g clipPath="url(#clip0_7444_2848)" fillRule="evenodd" clipRule="evenodd" fill="var(--color-primary-500)">
        <path
          opacity={0.33}
          d="M30.256.828l-1.034 3.859a20.304 20.304 0 00-1.71-.376 20.308 20.308 0 00-1.736-.239L26.14.094a24.168 24.168 0 014.116.734z"
        />
        <path opacity={0.38} d="M36.045 3.232l-2.009 3.461a18.895 18.895 0 00-3.15-1.476l1.371-3.757c1.327.48 2.59 1.081 3.788 1.772z" />
        <path opacity={0.42} d="M41.01 7.064l-2.84 2.815a20.12 20.12 0 00-2.665-2.253l2.31-3.265a24.551 24.551 0 013.194 2.703z" />
        <path opacity={0.5} d="M44.805 12.037l-3.464 1.993a20.5 20.5 0 00-1.988-2.864l3.068-2.56a23.569 23.569 0 012.384 3.431z" />
        <path opacity={0.55} d="M47.206 17.828l-3.87 1.027c-.297-1.13-.7-2.228-1.185-3.269l3.623-1.69a24.55 24.55 0 011.432 3.932z" />
        <path opacity={0.6} d="M48.005 24.046l-4-.013a20.147 20.147 0 00-.295-3.475l3.94-.679c.237 1.352.362 2.756.355 4.167z" />
        <path
          opacity={0.65}
          d="M47.626 28.214c-.123.69-.275 1.373-.455 2.042l-3.867-1.045c.15-.552.28-1.118.384-1.699.104-.58.178-1.167.229-1.737l3.988.366c-.06.68-.154 1.374-.279 2.073z"
        />
        <path opacity={0.7} d="M46.542 32.246a23.662 23.662 0 01-1.774 3.798l-3.461-2.01a19.903 19.903 0 001.478-3.159l3.757 1.371z" />
        <path opacity={0.75} d="M43.642 37.803A23.565 23.565 0 0140.94 41l-2.817-2.83c.817-.819 1.575-1.71 2.243-2.667l3.277 2.301z" />
        <path opacity={0.8} d="M39.385 42.407a23.57 23.57 0 01-3.424 2.397L33.97 41.34a20.494 20.494 0 002.855-2l2.561 3.067z" />
        <path opacity={0.95} d="M34.103 45.773a23.635 23.635 0 01-3.93 1.421l-1.039-3.862c1.131-.306 2.228-.7 3.28-1.192l1.689 3.633z" />
        <path d="M28.123 47.641a23.822 23.822 0 01-4.169.364l.013-4a20.758 20.758 0 003.466-.296l.69 3.932z" />
        <path
          opacity={0.05}
          d="M21.86 47.906a24.149 24.149 0 01-4.115-.734l1.035-3.869c.562.151 1.128.283 1.709.386.58.104 1.157.176 1.737.229l-.366 3.988z"
        />
        <path opacity={0.07} d="M17.116 42.783l-1.371 3.758a23.813 23.813 0 01-3.786-1.783l2.007-3.451a20.778 20.778 0 003.15 1.476z" />
        <path opacity={0.09} d="M12.496 40.364l-2.309 3.266a23.637 23.637 0 01-3.197-2.693l2.84-2.826a20.12 20.12 0 002.666 2.254z" />
        <path opacity={0.11} d="M8.649 36.824l-3.067 2.56a23.565 23.565 0 01-2.385-3.431l3.464-1.993a20.498 20.498 0 001.988 2.864z" />
        <path opacity={0.13} d="M5.85 32.414l-3.621 1.68a23.56 23.56 0 01-1.432-3.932l3.87-1.027c.297 1.13.7 2.228 1.183 3.279z" />
        <path opacity={0.15} d="M4.29 27.433l-3.942.688a23.66 23.66 0 01-.352-4.177l4 .013c-.007 1.177.1 2.344.294 3.476z" />
        <path
          opacity={0.17}
          d="M4.31 20.488c-.104.581-.177 1.157-.228 1.727l-3.99-.356a24.179 24.179 0 01.735-4.115l3.868 1.036c-.15.552-.282 1.128-.386 1.708z"
        />
        <path opacity={0.19} d="M6.694 13.955a20.156 20.156 0 00-1.478 3.16L1.46 15.744c.48-1.326 1.083-2.6 1.772-3.788l3.463 2z" />
        <path opacity={0.21} d="M9.879 9.83c-.815.81-1.573 1.7-2.242 2.658L4.36 10.187a24.551 24.551 0 012.703-3.195L9.88 9.83z" />
        <path opacity={0.25} d="M14.03 6.65a20.493 20.493 0 00-2.856 2l-2.56-3.068a23.568 23.568 0 013.423-2.396L14.03 6.65z" />
        <path opacity={0.28} d="M18.867 4.658c-1.131.306-2.227.7-3.28 1.193l-1.69-3.623A24.55 24.55 0 0117.829.796l1.038 3.862z" />
        <path opacity={0.3} d="M24.035 3.995a18.896 18.896 0 00-3.466.296L19.881.349a23.795 23.795 0 014.166-.354l-.012 4z" />
      </g>
      <defs>
        <clipPath id="clip0_7444_2848">
          <path fill="#fff" d="M0 0H48V48H0z" />
        </clipPath>
      </defs>
    </svg>
  )
}

export function DottedRoundSpinner(props: ComponentProps<'svg'>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52" fill="none" {...props}>
      <g clipPath="url(#clip0_7444_2967)" fillRule="evenodd" clipRule="evenodd" fill="var(--color-primary-500)">
        <path
          opacity={0.21}
          d="M19.668 4.93c-.278.077-.55.167-.824.266a2.005 2.005 0 01-2.54-1.243 1.996 1.996 0 011.243-2.54c.322-.115.641-.22.966-.314a2.013 2.013 0 012.499 1.335 2.004 2.004 0 01-1.344 2.495z"
        />
        <path
          opacity={0.25}
          d="M26.489 3.997c-.294-.001-.576-.01-.864.002a2.01 2.01 0 01-2.037-1.973c-.018-1.1.87-2.01 1.97-2.027.338-.005.677-.01 1.021-.002a1.996 1.996 0 011.949 2.049 1.982 1.982 0 01-2.04 1.951z"
        />
        <path
          opacity={0.28}
          d="M35.81 4.001a1.987 1.987 0 01-2.55 1.227l-.817-.268a1.987 1.987 0 01-1.328-2.497 1.991 1.991 0 012.495-1.319c.164.044.326.096.487.15.162.052.323.105.482.168a1.991 1.991 0 011.23 2.54z"
        />
        <path
          opacity={0.3}
          d="M42.139 8.106a2.01 2.01 0 01-2.81.384c-.225-.179-.457-.339-.695-.512a1.982 1.982 0 01-.488-2.78 1.996 1.996 0 012.783-.498c.283.198.553.402.822.606a2.003 2.003 0 01.388 2.8z"
        />
        <path
          opacity={0.33}
          d="M46.865 13.971c-.91.628-2.151.4-2.782-.502a11.353 11.353 0 00-.506-.702 2.004 2.004 0 01.394-2.807 2.013 2.013 0 012.804.403c.206.268.4.542.592.826.627.91.409 2.155-.502 2.782z"
        />
        <path
          opacity={0.38}
          d="M49.567 21.013a2.005 2.005 0 01-2.496-1.344c-.08-.269-.167-.55-.266-.824a2.005 2.005 0 011.243-2.54 1.997 1.997 0 012.539 1.243c.115.322.221.641.314.966a2.013 2.013 0 01-1.334 2.499z"
        />
        <path
          opacity={0.42}
          d="M49.95 28.537a2 2 0 01-1.948-2.049c-.002-.284.01-.575-.001-.863a1.995 1.995 0 011.97-2.027 1.99 1.99 0 012.03 1.96c.004.338.01.676.002 1.021a2.006 2.006 0 01-2.053 1.958z"
        />
        <path
          opacity={0.55}
          d="M50.867 33.614l-.318.97A2.006 2.006 0 0148 35.81a1.987 1.987 0 01-1.227-2.55l.268-.817a1.987 1.987 0 012.498-1.328 2.006 2.006 0 011.328 2.498z"
        />
        <path
          opacity={0.65}
          d="M47.3 40.928c-.198.282-.402.552-.606.822a1.995 1.995 0 01-2.8.387 2.01 2.01 0 01-.384-2.81c.179-.225.339-.457.512-.695a1.994 1.994 0 012.78-.488 1.996 1.996 0 01.498 2.784z"
        />
        <path
          opacity={0.7}
          d="M41.635 46.774a15.63 15.63 0 01-.826.593 1.988 1.988 0 01-2.782-.502c-.627-.91-.4-2.151.502-2.782.242-.163.476-.328.702-.506a2.004 2.004 0 012.807.394 2.013 2.013 0 01-.403 2.803z"
        />
        <path
          opacity={0.8}
          d="M34.453 50.586c-.322.116-.64.221-.966.315a2.013 2.013 0 01-2.498-1.335 2.004 2.004 0 011.344-2.495c.278-.078.55-.167.824-.267a2.006 2.006 0 012.54 1.243 1.996 1.996 0 01-1.244 2.54z"
        />
        <path d="M26.443 52.001c-.338.005-.676.01-1.021.002a1.996 1.996 0 01-1.949-2.049 1.986 1.986 0 012.04-1.951c.29.01.575.01.863-.002a2.01 2.01 0 012.037 1.973c.018 1.1-.87 2.01-1.97 2.027z" />
        <path
          opacity={0.05}
          d="M20.885 49.538a2.006 2.006 0 01-2.498 1.327l-.97-.317a2.006 2.006 0 01-1.227-2.55 1.994 1.994 0 012.55-1.226l.817.267a1.994 1.994 0 011.328 2.498z"
        />
        <path
          opacity={0.07}
          d="M13.856 46.802a1.996 1.996 0 01-2.784.498c-.282-.198-.552-.402-.822-.606a2.003 2.003 0 01-.387-2.8 2.01 2.01 0 012.81-.384c.225.179.453.348.695.512a1.986 1.986 0 01.488 2.78z"
        />
        <path
          opacity={0.09}
          d="M8.03 42.04a2.013 2.013 0 01-2.804-.403 15.647 15.647 0 01-.592-.826 1.996 1.996 0 01.501-2.782c.91-.628 2.152-.4 2.782.502.163.242.328.475.507.702a2.004 2.004 0 01-.394 2.807z"
        />
        <path
          opacity={0.11}
          d="M3.953 35.695a1.988 1.988 0 01-2.54-1.243c-.115-.322-.22-.64-.314-.966a2.013 2.013 0 011.335-2.499 2.004 2.004 0 012.495 1.345c.077.277.167.549.267.824a2.005 2.005 0 01-1.243 2.539z"
        />
        <path
          opacity={0.13}
          d="M2.027 28.412A1.995 1.995 0 010 26.442c-.005-.338-.01-.676-.002-1.021a1.996 1.996 0 012.049-1.949 1.994 1.994 0 011.952 2.04c-.002.294-.01.575 0 .863a2.01 2.01 0 01-1.972 2.037z"
        />
        <path
          opacity={0.19}
          d="M13.468 7.917c-.243.162-.48.338-.703.506a2.004 2.004 0 01-2.807-.394 2.013 2.013 0 01.404-2.804c.267-.206.541-.4.825-.592a1.996 1.996 0 012.782.502c.628.91.4 2.151-.501 2.782z"
        />
        <path
          opacity={0.15}
          d="M5.228 18.738l-.268.817a1.987 1.987 0 01-2.498 1.328 2.006 2.006 0 01-1.328-2.498l.318-.969A2.006 2.006 0 014 16.189a1.987 1.987 0 011.227 2.55z"
        />
        <path
          opacity={0.17}
          d="M8.49 12.672c-.178.226-.342.467-.511.695A2 2 0 114.7 11.072c.198-.282.402-.552.606-.822a1.99 1.99 0 012.797-.378 1.995 1.995 0 01.387 2.8z"
        />
      </g>
      <defs>
        <clipPath id="clip0_7444_2967">
          <path fill="#fff" d="M0 0H52V52H0z" />
        </clipPath>
      </defs>
    </svg>
  )
}

const spinnerStyles = cva('animate-spin', {
  variants: {
    size: {
      sm: 'size-5',
      md: 'size-7',
      lg: 'size-9',
      xl: 'size-10',
      xxl: 'size-12',
    },
  },
  defaultVariants: { size: 'md' },
})

export type SpinnerProps = ComponentProps<'svg'> &
  VariantProps<typeof spinnerStyles> & {
    type?: 'default' | 'dotted' | 'dotted-round'
    /** 仅 default 型有效：进度环的完成百分比（上游默认 80）。 */
    percentage?: number
    label?: string
  }

export function Spinner({ className, size = 'md', type = 'default', percentage = 50, label = '加载中', ...rest }: SpinnerProps) {
  // 与上游同解剖：Spinner 本体就是那个 <svg>，外面不再套 span，
  // 尺寸用 CSS 类控制（三个 svg 都带 viewBox，缩放不会裁剪）；颜色不做覆写，跟上游一样用 currentColor。
  const svgProps = {
    className: cn('animate-spin', spinnerStyles({ size }), className),
    role: 'status' as const,
    'aria-label': label,
    ...rest,
  }
  if (type === 'dotted') return <DottedSpinner {...svgProps} />
  if (type === 'dotted-round') return <DottedRoundSpinner {...svgProps} />
  return <DefaultSpinner percentage={percentage} {...svgProps} />
}
