import { useTranslations } from 'next-intl'
import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { CheckIcon } from '@/components/icons'
import { BLOCK_BODY, BLOCK_ROOT, BLOCK_TITLE } from './structure-styles'
import type { BlockComponentProps } from './types'

type Labels = { done: string; todo: string }

/** The mark of one task: a box, with a tick when it is done (a shape, not a color), hidden from assistive technology. */
function Mark({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-state={done ? 'done' : 'todo'}
      className={`absolute left-0 top-[0.35em] flex size-5 items-center justify-center rounded border ${
        done
          ? 'border-brand bg-brand text-white dark:text-neutral-950'
          : 'border-neutral-400 bg-white dark:border-neutral-500 dark:bg-neutral-950'
      }`}
    >
      {done ? <CheckIcon size={14} /> : null}
    </span>
  )
}

/**
 * Replaces each task-list checkbox the Markdown pipeline made (`<input type="checkbox" disabled>`) by a drawn mark plus text that
 * says whether the item is done, so the state is read as words. The checklist is read-only: no control is left in it.
 */
function readOnly(children: ReactNode, labels: Labels): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement(child)) return child
    const element = child as ReactElement<{ type?: string; checked?: boolean; children?: ReactNode }>
    if (element.type === 'input' && element.props.type === 'checkbox') {
      const done = Boolean(element.props.checked)
      return (
        <>
          <Mark done={done} />
          <span className="sr-only">{done ? labels.done : labels.todo}</span>{' '}
        </>
      )
    }
    if (element.props.children === undefined) return element
    const className = (element.props as { className?: string }).className
    const inner = readOnly(element.props.children, labels)
    // The list items of a task list lose their bullet and make room for the mark.
    return typeof element.type === 'string' && element.type === 'li' && className?.includes('task-list-item')
      ? cloneElement(element, { className: `${className} relative list-none pl-8` } as object, inner)
      : cloneElement(element, undefined, inner)
  })
}

/**
 * A read-only checklist: the body is a Markdown task list. Every item states in text whether it is done (the mark is a shape, not
 * only a color), the group is named by the title or by a default label, and nothing in it can be changed or focused.
 */
export function Checklist({ props, children }: BlockComponentProps<'checklist'>) {
  const t = useTranslations('Site.blocks')
  const titleId = useId()
  const labels = { done: t('itemDone'), todo: t('itemNotDone') }
  return (
    <div
      data-block="checklist"
      role="group"
      aria-labelledby={props.title ? titleId : undefined}
      aria-label={props.title ? undefined : t('checklistLabel')}
      className={`${BLOCK_ROOT} my-6 sm:my-8 rounded-card border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-800 dark:bg-neutral-900`}
    >
      {props.title ? (
        <p id={titleId} className={`${BLOCK_TITLE} mb-3 text-lg`}>
          {props.title}
        </p>
      ) : null}
      <div className={`${BLOCK_BODY} [&_ul]:m-0 [&_ul]:list-none! [&_ul]:p-0 [&_ul]:ps-0! [&_li]:my-2`}>
        {readOnly(children, labels)}
      </div>
    </div>
  )
}
