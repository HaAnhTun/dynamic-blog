/** Vietnamese titles and queries for the admin post-list search tests: accent- and case-insensitive matching is what is under test. */
export const PIPELINE_TITLE = 'Vì sao mỗi hop trong pipeline bất đồng bộ'
export const ACCENTED_QUERY = 'bất đồng bộ'
export const UPPERCASE_ACCENTED_QUERY = 'BẤT ĐỒNG BỘ'

export const MIXED_CASE_TITLE = 'Đường ống: ĐỌC dữ liệu #1'
export const MIXED_CASE_QUERY_MATCH = 'đọc dữ liệu #1'
export const MIXED_CASE_QUERY_MISS = 'đọc dữ liệu #2'

/** "Đ" does not decompose through NFD: it must still be found by the plain "d". */
export const D_STROKE_TITLE = 'Đường ống dữ liệu'
