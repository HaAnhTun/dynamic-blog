import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { setTestLocale, TEST_LOCALE } from './test/intl'
import './test/intl-setup'

// next/font only runs through the Next compiler; layouts that import RootShell would otherwise fail to load in a test.
vi.mock('next/font/google', () => ({ Inter: () => ({ variable: 'font-inter-test' }) }))

afterEach(() => setTestLocale(TEST_LOCALE))
