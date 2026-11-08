# Hướng dẫn quản trị

Dành cho người vận hành site. Mọi thứ ở đây được làm trên trình duyệt tại `/admin`, trừ khi có nói khác. Cài đặt và lần đăng nhập
đầu nằm ở [INSTALL.md](INSTALL.md) và [FIRST-RUN.md](FIRST-RUN.md). Bản tiếng Anh: [../ADMIN-GUIDE.md](../ADMIN-GUIDE.md).

## Nội dung

- [Vai trò và quyền](#vai-trò-và-quyền)
- [Khu vực quản trị](#khu-vực-quản-trị)
- [Bảo mật: xác minh hai bước và mật khẩu](#bảo-mật-xác-minh-hai-bước-và-mật-khẩu)
- [Cài đặt: nội dung của site](#cài-đặt-nội-dung-của-site)
- [Nhập từ tệp Markdown](#nhập-từ-tệp-markdown)
- [Nhập trang Giới thiệu bằng gói ZIP có ảnh](#nhập-trang-giới-thiệu-bằng-gói-zip-có-ảnh)
- [Xuất và nhập cả hồ sơ bằng một gói ZIP](#xuất-và-nhập-cả-hồ-sơ-bằng-một-gói-zip)
- [Nội dung mẫu](#nội-dung-mẫu)
- [Bài viết và bản dịch](#bài-viết-và-bản-dịch)
- [Nhập bài viết từ tệp Markdown](#nhập-bài-viết-từ-tệp-markdown)
- [Nhập gói bài viết có ảnh và các khối](#nhập-gói-bài-viết-có-ảnh-và-các-khối)
- [Tải một bài viết thành gói ZIP](#tải-một-bài-viết-thành-gói-zip)
- [Chủ đề, series, Bài viết hay và ảnh](#chủ-đề-series-bài-viết-hay-và-ảnh)
- [Bình luận, người dùng và đơn tác giả](#bình-luận-người-dùng-và-đơn-tác-giả)
- [Newsletter](#newsletter)
- [Tin nhắn liên hệ](#tin-nhắn-liên-hệ)
- [Thống kê và quyền riêng tư](#thống-kê-và-quyền-riêng-tư)
- [Tìm kiếm](#tìm-kiếm)

## Vai trò và quyền

Có ba vai trò. Backend áp dụng chúng; giao diện chỉ ẩn những gì bạn không dùng được.

| Vai trò | Ai | Đăng nhập thế nào |
|---|---|---|
| `USER` (độc giả) | Mọi tài khoản do việc đăng nhập GitHub tạo ra. | GitHub (khi bạn đã bật). |
| `AUTHOR` (tác giả) | Một độc giả được quản trị viên nâng quyền, bằng tay hoặc bằng cách duyệt đơn của họ. | Chỉ GitHub: tác giả không có mật khẩu. Tác giả có thể bật xác minh hai bước ở mục Bảo mật; từ đó mỗi lần đăng nhập đều hỏi mã. |
| `ADMIN` (quản trị viên) | Tài khoản chủ site tạo ở `/setup`, và mọi tài khoản được một quản trị viên nâng quyền. | Email và mật khẩu ở `/admin/login`, hoặc GitHub nếu đã liên kết ([CONFIGURATION.md](../CONFIGURATION.md#link-the-admin-account-to-github)), **rồi mã từ ứng dụng xác thực**: quản trị viên bắt buộc dùng xác minh hai bước. |

Một độc giả mở `/admin` sẽ được chuyển tới trang đăng nhập kèm lý do "không có quyền".

| Việc | Khách | `USER` | `AUTHOR` | `ADMIN` |
|---|---|---|---|---|
| Đọc trang công khai, bình luận, số lượt thích, tìm kiếm | có | có | có | có |
| Đăng ký nhận bài qua email (newsletter) | có | có | có | có |
| Bình luận, trả lời, thích, lưu bài, thông báo | không | có | có | có |
| Gửi đơn xin làm tác giả | không | có | không cần | không cần |
| Viết, sửa, đăng, gỡ, xoá bài **của mình**, kèm ảnh bìa, ảnh trong bài, các phiên bản cũ và bản dịch | không | không | có | có (mọi bài) |
| Nhập bài viết từ tệp Markdown (tạo bản nháp mới, hoặc cập nhật bài của mình; quản trị viên cập nhật mọi bài) | không | không | có | có |
| Xem và tạo chuyên mục và thẻ (trong trình soạn thảo) | không | không | có | có |
| Xem thống kê | không | không | chỉ bài của mình | cả site |
| Đánh dấu một bài là Bài viết hay, đặt thứ tự Bài viết hay | không | không | không | có |
| Đổi tên, xoá, gộp chuyên mục và thẻ (Chủ đề) | không | không | không | có |
| Series, ảnh, dung lượng lưu trữ ảnh | không | không | không | có |
| Kiểm duyệt bình luận (ẩn, hiện, xoá) | không | không | không | có |
| Người dùng: tạm khoá, mở khoá, đổi vai trò | không | không | không | có |
| Đơn tác giả: duyệt, từ chối | không | không | không | có |
| Trang Newsletter (số liệu), duyệt hoặc từ chối newsletter đang giữ | không | không | không | có |
| Tin nhắn liên hệ: đọc, đánh dấu đã đọc, xoá | không | không | không | có |
| Nội dung site (Cài đặt), nhập hồ sơ từ Markdown, xuất, nội dung mẫu | không | không | không | có |
| Chỉ mục tìm kiếm: reindex và trạng thái (API) | không | không | không | có |

Những quy tắc đáng biết:

- Tài khoản AUTHOR không có quyền với những thứ của cả site: series do quản trị viên quản lý, nên một bản dịch nháp do tác giả tạo
  không tự vào series. Một AUTHOR chỉ được liên kết các bài vào một nhóm bản dịch khi mọi bài trong nhóm đều là của họ.
- Đổi vai trò thu hồi mọi phiên đăng nhập của người đó. Hạ quyền có hiệu lực ở yêu cầu kế tiếp; nâng quyền có hiệu lực khi người đó
  đăng nhập lại. Nâng lên ADMIN thì lần đăng nhập kế tiếp là lần đăng ký xác minh hai bước; hạ về `USER` thì xoá lần đăng ký và các mã
  khôi phục.
- Không hạ quyền được quản trị viên (ADMIN) đang hoạt động cuối cùng, và tài khoản chủ site (tài khoản tạo ở `/setup`) chỉ được đổi
  theo yêu cầu của chính chủ site.
- ADMIN và AUTHOR không tạm khoá được: hãy hạ họ về `USER` trước.
- Qua các endpoint bình luận công khai, một quản trị viên chỉ sửa và xoá được bình luận của chính mình, như mọi người khác.

## Khu vực quản trị

Đăng nhập ở `/admin/login`: email và mật khẩu (hoặc GitHub), rồi mã 6 chữ số của ứng dụng xác thực. Lần đầu một quản trị viên đăng nhập,
trang sẽ đăng ký ứng dụng đó ([Bảo mật](#bảo-mật-xác-minh-hai-bước-và-mật-khẩu)). Thanh bên trái (nút "Menu" trên điện thoại) hiện, với một ADMIN: Bài viết, Thống kê, Chủ đề, Series,
Bài viết hay, Ảnh, Bình luận, Người dùng, Đơn tác giả, Newsletter, Liên hệ, Bảo mật và Cài đặt. Một AUTHOR thấy "Bài viết của tôi", Thống kê và Bảo mật. Một
trang cần vai trò khác sẽ hiện "Trang này chỉ dành cho quản trị viên". Trang quản trị có bộ chuyển ngôn ngữ riêng (lưu bằng
cookie), độc lập với các ngôn ngữ của site.

Trang đầu tiên là danh sách bài viết, có phần tổng quan, ô tìm kiếm không phân biệt dấu, bộ lọc theo trạng thái, chuyên mục, thẻ và
ngôn ngữ, và thao tác hàng loạt trên các bài đã chọn (đăng, gỡ, xoá; từ 1 tới 20 bài mỗi lần). Khối "Cần chú ý" đếm các bản nháp
chưa có chuyên mục, các Bài viết hay chưa được đăng, các bài chưa có mô tả ngắn và các bài chưa có thẻ; mỗi dòng là một bộ lọc, và
không dòng nào chặn việc đăng.

## Bảo mật: xác minh hai bước và mật khẩu

`/admin/security` (quản trị viên và tác giả) cho biết xác minh hai bước đang bật hay tắt, còn bao nhiêu mã khôi phục, và cho bạn quản lý
nó. Mọi thứ ở trang này, trừ "Đăng xuất mọi nơi", cần một lần đăng nhập **trong 10 phút gần nhất**: khi trang báo "đăng nhập lại để tiếp
tục", hãy đăng nhập lại rồi quay về đây.

- **Lần đăng ký đầu của quản trị viên.** Sau mật khẩu (hoặc GitHub), trang đăng ký có nút **Hiện khoá thiết lập**. Nó hiện khoá dạng
  văn bản, chia nhóm bốn ký tự, kèm nút **Sao chép** và một liên kết mở ứng dụng xác thực trên điện thoại (không có ảnh QR), rồi hỏi mã
  6 chữ số đầu tiên. Sau đó trang hiện **mười mã khôi phục một lần**: tải về hoặc sao chép chúng và đánh dấu ô thì nút **Vào khu vực quản
  trị** mới bấm được. Mỗi mã dùng một lần, khi bạn mất điện thoại. Một site có từ trước khi có xác minh hai bước trước hết hỏi **mã đăng
  ký**, mà chỉ ai đọc được máy chủ mới tìm ra (`MFA_ENROLLMENT_TOKEN`, hoặc `docker compose exec backend cat /data/mfa-enrollment-code`;
  [UPGRADING.md](../UPGRADING.md#release-with-two-step-verification), tiếng Anh). Đăng ký sẽ đăng xuất các thiết bị khác của bạn.
- **Bật, với tác giả.** "Bật", rồi **Hiện khoá thiết lập**: cùng khoá và mã đầu tiên như trên. Không cần mã đăng ký: tác giả đã đăng
  nhập sẵn.
- **Tạo mã khôi phục mới** hỏi một mã (từ ứng dụng, hoặc một mã khôi phục) và thay cả mười mã. Mã cũ ngừng dùng được.
- **Thay ứng dụng xác thực** (điện thoại mới) hỏi một mã từ ứng dụng hiện tại **hoặc một mã khôi phục**, và mật khẩu nếu tài khoản có,
  rồi hiện khoá mới và hỏi mã đầu tiên của ứng dụng mới. Tới khi mã đó được chấp nhận, ứng dụng cũ vẫn dùng được. Bạn nhận mười mã
  khôi phục mới.
- **Tắt** chỉ có với tác giả (hỏi một mã). Quản trị viên không tắt được.
- **Đổi mật khẩu** (tài khoản có mật khẩu): mật khẩu hiện tại, mật khẩu mới hai lần và một mã. Mật khẩu mới phải đạt
  [quy tắc mật khẩu](../SECURITY.md#password-policy) (tiếng Anh): 12 tới 128 ký tự, không phổ biến, không lặp hoặc liên tiếp, không chứa
  phần đầu email. Thiết bị khác bị đăng xuất; thiết bị này vẫn đăng nhập. Khi `ADMIN_PASSWORD` được đặt trong `.env`, trang báo máy chủ
  quản lý mật khẩu: bỏ biến đó đi để đổi ở đây.
- **Bạn ở lại đăng nhập bao lâu.** Phiên của quản trị viên hoặc tác giả kết thúc sau 7 ngày không dùng và, dù bạn dùng liên tục, sau 30
  ngày kể từ lúc đăng nhập; khi đó bạn đăng nhập lại, kèm mã mới nếu dùng xác minh hai bước. Chủ máy chủ đổi được cả hai giới hạn
  ([Cấu hình](../CONFIGURATION.md), tiếng Anh). Phiên của độc giả không có hạn cố định.
- **Đăng xuất mọi nơi** kết thúc mọi phiên của tài khoản, kể cả phiên này. Trang hỏi lại "Đăng xuất khỏi mọi thiết bị?" trước, rồi đưa bạn tới trang đăng nhập.
- Nếu trang đăng nhập báo máy chủ chưa kết thúc được phiên sau khi bạn đăng xuất, nghĩa là lúc đó không kết nối được tới máy chủ:
  bạn đã đăng xuất trên thiết bị này, nhưng phiên vẫn còn hiệu lực đến khi hết hạn. Hãy đăng nhập lại rồi dùng "Đăng xuất mọi nơi" để
  kết thúc ngay.

**Mất điện thoại?** Đăng nhập bằng một mã khôi phục thay cho mã 6 chữ số, rồi dùng "Thay ứng dụng xác thực". Không còn mã khôi phục thì
quản trị viên mất điện thoại cần người quản lý máy chủ ([Bảo mật](../SECURITY.md#when-the-phone-or-the-codes-are-lost), tiếng Anh): đặt
`MFA_RESET_EMAIL` và `MFA_RESET_TOKEN` rồi khởi động lại. Nếu một mã đúng mà vẫn bị từ chối, kiểm tra giờ của điện thoại và của máy chủ
([TROUBLESHOOTING.md](../TROUBLESHOOTING.md#two-step-codes-are-rejected)); mỗi mã cũng chỉ dùng được một lần, nên hãy đợi mã kế tiếp.

## Cài đặt: nội dung của site

Mọi thứ "về một con người" là dữ liệu, không phải mã, và nằm ở **Quản trị, Cài đặt** (`/admin/settings`, trang "Nội dung site",
chỉ ADMIN). Phần mềm không có sẵn thông tin nào về chủ site; một bản cài mới hiện nội dung giữ chỗ trung tính.

Trang liệt kê các mục. Mỗi mục được sửa **theo từng ngôn ngữ**: chọn "Ngôn ngữ của nội dung" ở đầu trang, và mỗi mục hiện thêm bản
của ngôn ngữ kia để tham khảo.

| Mục | Chứa gì |
|---|---|
| Chung | Tên site (đầu trang, chân trang, tiêu đề trang, feed), khẩu hiệu, câu định vị (mô tả trang mặc định và chân trang). |
| Hồ sơ và phần chào | Tên, vai trò, nơi ở, điều bạn đang tìm kiếm, lời chào ở trang chủ, tiêu đề và dòng phụ, lời dẫn của trang ảnh, ảnh đại diện (JPEG hoặc PNG; tải lên chưa đổi hồ sơ cho tới khi bạn lưu). |
| Giới thiệu | Phần mở đầu, phần thân Markdown tùy chọn với các khối của bài viết, và các mục gồm các đoạn văn cho trang Giới thiệu. |
| Kỹ năng | Các nhóm kỹ năng với mức cho từng mục (đã dùng trong dự án, đã làm việc cùng, đang học). Hiển thị dạng thẻ chuyển ở trang Giới thiệu. |
| Hiện tại | Điều bạn đang làm lúc này, kèm liên kết tuỳ chọn. |
| Dòng thời gian | Các mục học vấn và kinh nghiệm, mỗi mục có công ty hoặc trường, liên kết, thời gian, địa điểm, bộ phận, mô tả ngắn, các điểm nổi bật, công nghệ và logo. Là một biểu mẫu: thêm, xoá và di chuyển mục. |
| Liên hệ | Email, liên kết GitHub, một ghi chú ngắn và các liên kết khác. |
| Blog nên đọc | Những site đáng đọc. |
| Case study | Bài viết có vấn đề, giải pháp và kết quả đo được (một số đo cần có nguồn). |

**Biểu mẫu dòng thời gian.** Mục Dòng thời gian là một biểu mẫu, không phải ô JSON. Mỗi mục có loại (kinh nghiệm hoặc học vấn), vị trí
hoặc bằng cấp, công ty hoặc trường, một liên kết (`https://`) mà tên dẫn tới, thời gian (văn bản tự do như `09/2023 - Hiện tại`), địa
điểm, bộ phận, mô tả ngắn, các điểm nổi bật (mỗi dòng một gạch đầu dòng, tối đa 12) và công nghệ (mỗi dòng một công nghệ, hiển thị
dạng nhãn, tối đa 30). **Thêm một mục**, **Xoá**, **Lên** và **Xuống** đổi danh sách và thứ tự các trang công khai hiển thị. Logo chỉ
đến từ việc nhập gói ZIP ([bên dưới](#xuất-và-nhập-cả-hồ-sơ-bằng-một-gói-zip)): biểu mẫu hiện logo, giữ nguyên khi bạn lưu và có
**Gỡ logo**, nhưng không tải logo lên được. Biểu mẫu báo danh sách quá dài trước khi cho lưu. Một mục cũ chỉ có tiêu đề, công ty hoặc
trường, thời gian và mô tả vẫn hợp lệ.

**Hiển thị ở đâu.** Mục "Chặng đường" ở trang chủ liệt kê các mục kinh nghiệm và học vấn cùng các chi tiết này theo bố cục gọn; trang
Giới thiệu hiện mỗi mục thành một thẻ (công ty hoặc trường là tiêu đề, có liên kết nếu có, logo ở góc trên bên phải). Trang chủ không
còn mục kỹ năng: kỹ năng nằm ở các thẻ chuyển của trang Giới thiệu. Ngay sau Bài viết hay, trang chủ có khối **Series** với các series
đã đăng mới nhất của ngôn ngữ (tên, mô tả, số phần, liên kết). Không có gì để cài: đăng một series là nó xuất hiện; chưa có series nào
đã đăng thì khối này ẩn.

Cần biết:

- **Mỗi lần lưu giữ lại phiên bản trước**; 10 phiên bản gần nhất của mỗi mục và ngôn ngữ được liệt kê ở "Các phiên bản trước" kèm nút
  Khôi phục.
- **Xuất và nhập (JSON).** "Tải bản <ngôn ngữ> (JSON)" xuất các mục đã lưu của một ngôn ngữ. Nhập nhận một tệp do chức năng xuất
  tạo ra (tối đa 512 KiB; ngôn ngữ được đọc từ trong tệp); mọi mục được kiểm tra trước và nếu có chỗ nào sai thì không nhập gì cả.
- **Máy chủ kiểm tra mọi thứ.** Văn bản là văn bản thuần và được hiển thị đã thoát ký tự; liên kết phải là `https://` hoặc
  `mailto:`; không trường nào mang được vai trò hay quyền. Lưu, khôi phục và nhập đều bị giới hạn tần suất (60 lần mỗi 10 phút cho
  mỗi quản trị viên).
- **Lưu xong hiện ngay** trên các trang công khai. Điều này giả định một backend và một tiến trình Next, đúng như compose chạy.
- **Ngôn ngữ hiện ở chế độ chỉ đọc** ở đầu trang ("Ngôn ngữ mặc định ... Ngôn ngữ đang bật ..."): chúng là thiết lập triển khai
  ([CONTENT-AND-I18N.md](../CONTENT-AND-I18N.md)).
- Một ngôn ngữ chưa lưu gì sẽ hiện bản của ngôn ngữ mặc định, rồi tới các giá trị mặc định đi kèm.

## Nhập từ tệp Markdown

Thay vì điền từng mục bằng tay, hãy nhập cả hồ sơ từ một tệp Markdown: **Quản trị, Cài đặt, Nhập Markdown**
(`/admin/settings/import`). Không có gì được ghi cho tới khi bạn xác nhận. Định dạng tệp được mô tả ở
[site-profile-format.md](../site-profile-format.md).

1. **Chọn ngôn ngữ và tải tệp mẫu.** Tệp mẫu liệt kê mọi mục và trường cùng giới hạn của chúng, và kèm hướng dẫn cho một trợ lý AI.
   Ngôn ngữ bạn chọn quyết định tệp ghi vào ngôn ngữ nào. "Xuất nội dung hiện tại" tải về nội dung đã lưu của bạn theo cùng định
   dạng, để bạn sửa rồi nhập lại; "Xuất gói ZIP kèm ảnh" làm như vậy kèm cả ảnh
   ([bên dưới](#xuất-và-nhập-cả-hồ-sơ-bằng-một-gói-zip)).
2. **Điền tệp.** Bằng tay, hoặc bằng một trợ lý AI (xem bên dưới).
3. **Tải lên** một tệp `.md` tối đa 256 KiB, hoặc một gói `.zip` tối đa 4 MiB khi trang Giới thiệu có ảnh hay hình
   ([bên dưới](#nhập-trang-giới-thiệu-bằng-gói-zip-có-ảnh)); chọn hoặc thả vào.
4. **Xem kết quả xem thử.** Với mỗi mục, nó cho biết: mới, sẽ thay đổi (kèm trước và sau), không đổi, thiếu (tuỳ chọn) hoặc lỗi, và
   liệt kê mọi thứ bị bỏ qua (mục và trường không biết). Một mục có lỗi sẽ chặn việc áp dụng cho tới khi sửa xong. Một giá trị thiếu
   hoặc rỗng không bao giờ xoá gì; một danh sách trong tệp thay thế cả danh sách đang lưu (bản xem thử đếm số mục thêm, bớt và giữ).
5. **Chọn các mục và một chế độ.** *Chỉ tạo mới* bỏ qua các mục đã có nội dung ở ngôn ngữ đó; *Cập nhật* ghi các mục đã chọn. Bấm
   **Áp dụng**.
6. **Hoàn tác.** Trang đưa ra nút **Hoàn tác lần nhập này** chừng nào chưa có mục nào của lần nhập bị sửa sau đó: nó khôi phục
   phiên bản trước của mọi mục lần nhập đã ghi và xoá các mục nó đã tạo.

Tệp chỉ là văn bản, không bao giờ là mã. Nó không đặt được vai trò, quyền, mật khẩu hay bất kỳ thiết lập bảo mật nào, và backend
kiểm tra rồi phân tích lại nó lúc áp dụng (xác nhận đó đúng là tệp bạn đã xem thử). Nhật ký nhập lưu ai, khi nào, một mã băm và số
lượng, không bao giờ lưu nội dung. Định dạng bao gồm Chung, Danh tính, Mục tiêu nghề nghiệp, Giới thiệu, Kỹ năng, Hiện tại, Dòng
thời gian, Liên hệ và Blog nên đọc; case study và ảnh đại diện vẫn nằm ở trình soạn thảo riêng của chúng.

**Phần thân trang Giới thiệu.** Trang Giới thiệu không phải một bộ phần tử cố định. Ngoài phần mở đầu và các mục, trình soạn thảo
Giới thiệu có ô **Phần thân trang** (tối đa 20000 ký tự) dùng cùng Markdown và các [khối](../content-blocks.md) như bài viết: hộp
chú ý, số liệu, dòng thời gian, thẻ, cây tệp, các bước, chi tiết, điểm chính, hình, bảng so sánh, sơ đồ và thẻ mã. Trang hiển thị
phần thân sau phần mở đầu và trước các thẻ mục, đưa các tiêu đề `##` và `###` vào "Trên trang này", và hiển thị tiêu đề `#` như
tiêu đề cấp hai (tiêu đề trang là tiêu đề cấp một duy nhất). Để trống ô nếu không cần phần thân; khối không hợp lệ hiển thị như văn
bản thường và HTML không an toàn bị loại bỏ, giống như trong bài viết. Để nhập, điền mục `# About page` của tệp hồ sơ: mọi thứ cho
đến tiêu đề `#` tiếp theo nằm ngoài khối mã là phần thân, giữ nguyên các khối, khối mã, bảng và danh sách như đã viết
([site-profile-format.md](../site-profile-format.md)). Trình soạn thảo có liên kết tới cùng lời nhắc soạn bài của chức năng nhập
bài viết, để trợ lý biết các khối được hỗ trợ. Mục để trống không ghi gì và không bao giờ xoá phần thân đang có.

**Dùng trợ lý AI.** Tải tệp mẫu, đưa cả tệp cho một trợ lý cùng CV hoặc ghi chú của bạn, và yêu cầu nó điền vào mẫu và chỉ trả về
tệp. Sau đó kiểm tra:

- mọi sự kiện (tên, ngày, liên kết) so với hồ sơ của chính bạn: trợ lý có thể bịa chi tiết, và bản xem thử cho thấy cái gì sẽ đổi
  nhưng không biết một khẳng định có đúng hay không;
- rằng câu trả lời là chính tệp đó chứ không bọc trong một khối mã (một dòng bắt đầu bằng ba dấu backtick là lỗi), và tên các mục
  vẫn bằng tiếng Anh dù văn bản viết bằng ngôn ngữ nào;
- rằng không có gì riêng tư trong đó. Đừng đưa cho trợ lý dữ liệu bạn không muốn công bố, và đừng bao giờ đặt mật khẩu hay token
  vào tệp: định dạng không có trường nào cho chúng.

## Nhập trang Giới thiệu bằng gói ZIP có ảnh

Trang Giới thiệu có thể hiện một ảnh ở đầu trang và các hình trong phần thân. Chúng đến qua chính chức năng nhập hồ sơ, dưới dạng
một **gói ZIP**: **Quản trị, Cài đặt, Nhập Markdown**, rồi chọn tệp `.zip` thay vì tệp `.md`. Trình soạn thảo Giới thiệu không có chỗ
tải ảnh lên: nó hiện ảnh đang lưu cùng nút **Gỡ ảnh**, và lưu trang không bao giờ làm mất ảnh.

**Gói chứa gì.** Một tệp `.md` theo [định dạng tệp hồ sơ](../site-profile-format.md), ở đầu gói hoặc trong một thư mục cấp trên cùng,
và các ảnh trong `assets/` (JPEG, PNG hoặc WebP; nội dung tệp quyết định, không phải tên). Gói theo cùng quy tắc và giới hạn của một
[gói bài viết](#nhập-gói-bài-viết-có-ảnh-và-các-khối): tối đa 4 MiB, 40 mục, không có đường dẫn gian lận, và không có gì ngoài một
tệp `.md` cùng các ảnh.

```text
about.zip
  profile.md
  assets/me.jpg
  assets/diagram.png
```

**Ảnh của trang.** Trong mục `# About` của tệp, thêm dòng `- photo: assets/me.jpg`. Trang hiện ảnh này ở dải đầu trang; không có thì
hiện ảnh đại diện của hồ sơ, và không có cả hai thì không có ảnh. Dòng `- photo: /media/<id>.jpg` (đường dẫn của một ảnh site đã
lưu, đúng là thứ **Xuất nội dung hiện tại** ghi ra) được nhập lại không đổi. Bỏ dòng này thì ảnh đang lưu được giữ nguyên; muốn bỏ ảnh,
dùng **Gỡ ảnh** trong trình soạn thảo Giới thiệu.

**Hình trong phần thân trang.** Trong mục `# About page`, dẫn tới hình bằng `assets/diagram.png` trong ảnh Markdown, khối `figure`
và khối `gallery`. Chúng được lưu như ảnh đại diện và các tham chiếu được viết lại thành địa chỉ đã lưu. Một hình không nơi nào dùng
được liệt kê trong bản xem thử là không dùng và không được lưu; tham chiếu tới hình không có trong gói là một vấn đề và chặn việc
áp dụng.

**Bản xem thử nói gì.** Bản xem thử hiện ảnh và các hình như thay đổi của mục Giới thiệu: đường dẫn ảnh mới, và số hình trong phần thân
được thêm, bớt hay giữ; nó không bao giờ hiện nội dung tệp. Nó báo là vấn đề: đường dẫn `assets/` trong tệp `.md` thường (tệp Markdown
thường không mang được ảnh: hãy dùng gói, hoặc đường dẫn `/media/...`), đường dẫn không có trong gói, và một mục không phải ảnh
JPEG, PNG hay WebP (kể cả SVG). Không có gì được ghi cho tới khi bạn xác nhận. Các ảnh được lưu khi bạn áp dụng, trước khi nội dung
được ghi; một ảnh hỏng sẽ được phát hiện lúc đó và không có gì được ghi.

**Nhập hai lần và hoàn tác.** Cùng gói đó nhập lần nữa là **không đổi** (ảnh có cùng byte dùng lại ảnh đã lưu). **Hoàn tác lần nhập
này** khôi phục nội dung Giới thiệu trước đó, gồm cả ảnh trước đó; các ảnh lần nhập đã lưu vẫn ở lại kho ảnh.

Tệp `.md` thường hoạt động đúng như trước.

## Xuất và nhập cả hồ sơ bằng một gói ZIP

**Quản trị, Cài đặt, Nhập Markdown** có hai nút tải nội dung đã lưu của một ngôn ngữ: **Xuất nội dung hiện tại** (tệp hồ sơ `.md`) và
**Xuất gói ZIP kèm ảnh** (`site-profile-<ngôn ngữ>.zip`). Gói gồm tệp hồ sơ và mọi ảnh mà nội dung dùng: ảnh trang Giới thiệu, các hình
trong phần thân trang Giới thiệu và logo ở chặng đường. Tệp dẫn tới mỗi ảnh bằng đường dẫn bên trong gói, nên một gói ZIP là cả hồ sơ.

Nhập lại chính gói ZIP đó trên cùng site thì bản xem thử báo **không đổi**. Nhập nó trên một site trống, hoặc vào ngôn ngữ kia của
site, thì phần nhập khôi phục nội dung và các ảnh. Vì vậy gói là bản sao lưu, là cách chuyển hồ sơ sang site khác, và là thứ một trợ
lý AI có thể sửa rồi trả lại. Mọi điều còn lại về gói (giới hạn, bản xem thử, **Hoàn tác lần nhập này**) được mô tả ở phần trên. Để
gán logo cho một mục dòng thời gian bằng tệp viết tay, thêm dòng `- logo: assets/company.png` dưới mục đó và đặt ảnh vào gói
([site-profile-format.md](../site-profile-format.md#timeline)); dùng **Gỡ logo** trong biểu mẫu dòng thời gian để bỏ.

## Nội dung mẫu

Ở trang Cài đặt, khung **Nội dung mẫu** có nút **Nạp nội dung mẫu** (chỉ ADMIN). Nó thêm bốn bài viết đã đăng (một bài "chào mừng"
và một bài "viết bằng Markdown", mỗi bài có bản tiếng Anh và tiếng Việt, liên kết làm bản dịch), series "Bắt đầu", chuyên mục
"Hướng dẫn" và các thẻ "welcome" và "markdown". Nó báo đã tạo gì và giữ nguyên gì; bấm lần nữa không đổi gì. Các bài thuộc về
bạn; sửa hoặc xoá lúc nào cũng được. Chúng cũng xếp một lượt gửi newsletter vào hàng đợi như mọi lần đăng lần đầu, nên hãy nạp
chúng trước khi mở newsletter cho độc giả.

## Bài viết và bản dịch

**Viết bài.** Bấm "Viết bài". Trình soạn thảo chiếm toàn màn hình. Ctrl hoặc Cmd cộng S để lưu; khi còn thay đổi chưa lưu, **Đăng
bài** lưu trước rồi mới đăng; trình duyệt cảnh báo trước khi bạn rời đi với thay đổi chưa lưu. Dòng thông tin hiện số từ và thời
gian đọc. Bạn đặt tiêu đề, mô tả ngắn (dùng trong danh sách, feed, newsletter và kết quả tìm kiếm), chuyên mục (bắt buộc để đăng),
thẻ, ảnh bìa (kèm văn bản thay thế) và nội dung bằng Markdown. Ảnh trong bài được tải lên ngay trong trình soạn thảo và gắn với bài
đó. Một trang xem trước hiện bài đúng như độc giả sẽ thấy. Nếu trang xem trước báo bài **quá nặng** cho bộ đọc Markdown (hàng nghìn khối
trích dẫn, hàng nghìn tiêu đề gạch chân bằng `---`, hàng nghìn thẻ HTML, một đoạn rất dài toàn ký tự `*`, `_`, `[` hoặc `]` (hoặc hàng chục nghìn ký tự đó rải khắp bài, kể cả liên kết và chữ nhấn mạnh), một từ dài
hàng chục nghìn ký tự, hàng nghìn địa chỉ web hoặc e-mail viết trần, ô bảng hoặc dấu hai chấm trong cùng một đoạn, một đoạn mã dài không có
dòng trống nào, hoặc hơn khoảng 5.000 dòng), bài được hiện như văn bản thuần, kể cả tiêu đề và liên kết, nên độc giả thấy đúng như vậy
cho đến khi bạn tách bài (đoạn mã dài thì tách thành nhiều khối mã) hoặc bỏ bớt các ký tự đó.
Việc tô màu mã có giới hạn: dòng từ 300 ký tự trở lên, khối mã từ khoảng 375 dòng trở lên và phần mã vượt quá 120.000 ký tự hoặc 2.000 dòng
trong một bài được hiện không tô màu (nội dung vẫn đầy đủ). Bài bạn gỡ xuất bản hoặc xoá ở đây biến mất khỏi site ngay; bài bị đổi ngoài trang
quản trị (một script, API) có thể còn hiện tối đa một giờ, và CDN đặt phía trước giữ nguyên cho đến khi bạn purge
([Cài đặt](INSTALL.md#cdn-đặt-phía-trước)). Xoá bài nằm ở cuối cột cài đặt. **Quản trị viên xoá hẳn**: ảnh bìa, ảnh trong
bài, các phiên bản cũ, slug cũ, bình luận, lượt thích và bài đã lưu của độc giả cùng bản ghi newsletter đi theo bài. **Tác giả xoá thì
bài chỉ bị ẩn**: bài rời khỏi site, tìm kiếm và danh sách của tác giả, còn mọi thứ thuộc về người khác được giữ nguyên (bình luận,
lượt thích, bài đã lưu, bản ghi newsletter, ảnh). Địa chỉ của bài vẫn bị giữ chỗ, và bài rời khỏi nhóm bản dịch, nên bản dịch còn lại có thể được liên kết với bài khác. Quản trị viên thấy bài bị ẩn trong danh sách với nhãn
"Đã lưu trữ" và có thể xoá hẳn, hoặc đăng lại để đưa nó trở về. Mỗi lần xoá đều được ghi log kèm id bài, người xoá và số bình luận
(không có nội dung). Hộp xác nhận cho tác giả nói rõ bài chỉ rời khỏi danh sách của họ và khỏi site, quản trị viên vẫn giữ và có thể khôi phục hoặc xoá hẳn; chỉ hộp xác nhận của quản trị viên mới nói "vĩnh viễn".

**Bản sao chưa lưu.** Khi bạn gõ, trình soạn thảo giữ một bản sao phần chưa lưu trong trình duyệt này, một giây sau lần gõ cuối,
nên tab bị treo hay cửa sổ bị đóng không làm mất chữ; mở lại bài sẽ được hỏi có khôi phục không. Bản sao thuộc về tài khoản của bạn
(tài khoản khác dùng chung trình duyệt không bao giờ thấy nó) và bị xoá khi bạn lưu, khi bạn đăng xuất (nút **Đăng xuất**, menu tài
khoản trên site, hoặc **Đăng xuất mọi nơi**, cũng chặn trình soạn thảo đang mở ở tab khác ghi lại nó) và sau 7 ngày. Nếu phiên chỉ hết
hạn, bản sao vẫn còn để đăng nhập lại là khôi phục được.

**Các phiên bản cũ (revision).** Khi một lần lưu đổi tiêu đề, mô tả hoặc nội dung, văn bản trước đó có thể được giữ làm một phiên
bản (tối đa 20, mới nhất trước); khôi phục một phiên bản sẽ giữ văn bản hiện tại làm một phiên bản trước, và không đụng tới slug,
trạng thái hay phân loại.

**Slug.** Slug là URL của bài. Một khi đã đặt, nó không bao giờ được suy ra lại từ tiêu đề, nên sửa tiêu đề không làm bài đã đăng
đổi chỗ. Khi bạn đổi slug của một bài từng được đăng, URL cũ vẫn dùng được nhờ chuyển hướng. Một slug đã bị dùng sẽ được thêm hậu
tố số (quá năm mươi số thì dùng hậu tố ngẫu nhiên). Bài do tác giả viết chỉ giữ năm địa chỉ cũ mới nhất; để giải phóng ngay một
địa chỉ cũ, quản trị viên gọi `DELETE /api/v1/admin/slug-history/<slug-cũ>` (nó thôi chuyển hướng và bài nào cũng có thể dùng nó).

**Đăng bài.** Một bản nháp chỉ tác giả của nó và các quản trị viên thấy. Đăng làm bài công khai và, lần đầu tiên, xếp lượt gửi
newsletter vào hàng đợi ([Newsletter](#newsletter)); lượt gửi của bài do AUTHOR đăng phải chờ quản trị viên. Gỡ đưa bài khỏi site nhưng vẫn giữ nó; quản trị viên xoá thì loại bỏ bài vĩnh viễn, còn tác giả xoá thì bài chỉ bị ẩn (xem phần "Bài viết và bản dịch") và hộp xác nhận của tác giả nói rõ điều đó. Chỉ một
ADMIN mới đánh dấu một bài là nổi bật (Bài viết hay).

**Ngôn ngữ và bản dịch.** Mỗi bài thuộc một ngôn ngữ, chọn trong trình soạn thảo. Để cung cấp một bài viết ở ngôn ngữ khác, dùng
khung **Bản dịch** của trình soạn thảo:

- *Tạo bản dịch bằng*: chọn ngôn ngữ, và tuỳ chọn một đường dẫn ("Đường dẫn của bản dịch"; để trống nghĩa là đường dẫn của bài này
  cộng ngôn ngữ). Bản nháp mới sao chép tiêu đề, mô tả, chuyên mục và thẻ và chưa có nội dung; hãy viết nó và đăng khi sẵn sàng.
- *Liên kết một bài có sẵn*: chọn một bài khác thuộc ngôn ngữ khác để liên kết chúng làm bản dịch của nhau.
- *Gỡ liên kết bài này*: chỉ xoá liên kết; các bài vẫn giữ nguyên.

Độc giả chỉ thấy "Đọc bài này bằng ngôn ngữ khác" khi tồn tại một bản dịch **đã đăng**, và `hreflang` cùng các bản thay thế trong
sitemap theo cùng quy tắc đó. Một bản dịch có trạng thái riêng: đăng một ngôn ngữ không làm đăng ngôn ngữ kia. Danh sách bài có bộ
lọc ngôn ngữ. Chi tiết: [CONTENT-AND-I18N.md](../CONTENT-AND-I18N.md#translating-posts).

## Nhập bài viết từ tệp Markdown

Khi một bài đã có sẵn dưới dạng tệp Markdown (viết bằng công cụ khác, hoặc nháp cùng trợ lý AI), hãy nhập nó thay vì chép từng trường
vào trình soạn thảo: **Quản trị, Bài viết, Nhập bài viết** (`/admin/posts/import`). Cả quản trị viên và tác giả đều dùng được. Đây
không phải là phần nhập hồ sơ ở Cài đặt ([Nhập từ tệp Markdown](#nhập-từ-tệp-markdown)): phần đó điền nội dung của site và chỉ dành
cho quản trị viên. Định dạng tệp được mô tả ở [post-file-format.md](../post-file-format.md) (tiếng Anh).

**Ai làm được gì.**

| Vai trò | Nhập bài viết |
|---|---|
| `AUTHOR` (tác giả) | Được. Mọi bài mới là bản nháp thuộc về tác giả. Một tệp cũng có thể cập nhật bài của chính tác giả, không bao giờ bài của người khác. |
| `ADMIN` (quản trị viên) | Được. Bài mới là bản nháp thuộc về quản trị viên. Một tệp cũng có thể cập nhật mọi bài; tác giả của bài được cập nhật không đổi. |
| `USER` (độc giả), khách | Không. Backend từ chối với 403 và 401. |

Nhập bài không bao giờ đăng bài và không bao giờ đổi tác giả, slug, ngôn ngữ, trạng thái hay cờ nổi bật của một bài. Gói ZIP có thể đặt ảnh bìa cho bài, và khi đó ảnh bìa trong gói thay ảnh bìa mà bài đang có (xem bên dưới). Tệp của quản trị viên có thể tạo series theo tên và đưa bài vào phần nó khai (`series`, `series_part`, `series_description`; [post-file-format.md](../post-file-format.md#series)); với tác giả các khoá đó bị bỏ qua. Xem thử và nhập bài bị giới hạn tốc độ (tổng cộng 60 lần
mỗi 10 phút cho mỗi người, [CONFIGURATION.md](../CONFIGURATION.md)).

1. **Tải tệp mẫu.** Chọn ngôn ngữ bạn viết và bấm **Tải tệp mẫu**. Tệp liệt kê các khoá nó dùng cùng giới hạn (không có `translation_of`, vì import chưa áp dụng khoá này), kèm hướng dẫn cho trợ lý AI
   (không bịa sự kiện, con số, ngày tháng hay liên kết; chỉ trả về tệp) và một bài ví dụ trung lập. Nút **Tải gói ZIP** của một bài ghi
   cùng định dạng thành một gói ([bên dưới](#tải-một-bài-viết-thành-gói-zip)).
2. **Chọn các tệp.** Tối đa 20 tệp, mỗi tệp một bài: tệp `.md` tối đa 256 KiB, hoặc gói `.zip` tối đa 4 MiB chứa một bài viết cùng
   ảnh của nó ([xem bên dưới](#nhập-gói-bài-viết-có-ảnh-và-các-khối)); tổng cộng 4 MiB (chọn hoặc thả vào). Một tệp cần có tiêu đề và
   nội dung; mọi khoá khác là tuỳ chọn.
3. **Xem thử.** Chưa có gì được ghi. Mỗi tệp cho biết đó là **bài mới** hay có **lỗi**, và hiện slug sẽ dùng (cùng nguồn của nó: khoá
   `slug`, tên tệp hay tiêu đề), ngôn ngữ (ngôn ngữ mặc định của site khi tệp không nêu), các chuyên mục và thẻ chưa tồn tại sẽ được
   tạo, với tệp của quản trị viên thì có thêm series sẽ được tạo cùng series và phần của bài, và danh sách các khoá bị bỏ qua. Một bài chưa có chuyên mục mà tệp cũng không nêu chuyên mục sẽ có một ghi chú: bài vẫn được nhập thành
   bản nháp, nhưng bạn cần chọn chuyên mục ở trình soạn thảo trước khi đăng. Một lỗi nêu khoá và số dòng, không bao giờ nêu văn bản trong tệp của bạn. Hai tệp có cùng
   slug đều bị báo lỗi. Một tệp có slug là slug của một bài bạn được quản lý (tác giả: bài của mình; quản trị viên: mọi bài) là một
   **thay đổi** của bài đó, hoặc **không đổi** khi tệp không có gì mới; khoá thiếu hoặc để trống giữ nguyên giá trị đã lưu, và thay đổi
   một bài đã đăng được cảnh báo và không được chọn sẵn. Slug của bài người khác là lỗi.
4. **Chọn và xác nhận.** Bài mới được chọn sẵn; bỏ chọn những tệp bạn chưa muốn nhập. Một tệp có lỗi không thể được chọn và bị loại khỏi lần nhập.
   Bấm **Nhập**: mọi tệp đã chọn được tạo trong một bước (được cả hoặc không gì cả), dưới dạng bản nháp, cùng các chuyên mục và thẻ
   chưa có (và series chưa có). Nếu có gì đổi sau lần xem thử (ví dụ một slug vừa bị dùng), không có gì được ghi và bạn được yêu cầu xem thử lại.
5. **Mở các bản nháp.** Trang kết quả liệt kê những gì đã tạo, kèm liên kết mở từng bản nháp trong trình soạn thảo. Hãy xem lại,
   chọn chuyên mục nếu tệp không có, và đăng ở đó (gói có ảnh bìa đã đặt ảnh đó làm ảnh bìa). Một bài không có chuyên mục thì không đăng được.

Nhập lại cùng một tệp không tạo bài thứ hai: slug của nó giờ đã thuộc về bài đầu, nên tệp là một bản cập nhật của bài đó, và khi
không có gì trong tệp khác với bài thì nó được hiện là **không đổi** và không có gì được ghi. Đổi dòng `slug` của một tệp sẽ tạo một
bản nháp mới; nó không đổi tên bài.

**Cập nhật một bài.** Một tệp cập nhật bài có slug hiện tại giống nó (khoá `slug`, nếu không thì tên tệp, nếu không thì tiêu đề; phần
xem thử cho biết nguồn nào). Tệp của tác giả chỉ khớp với bài của chính tác giả; tệp của quản trị viên khớp với mọi bài. Slug của một
bài bạn không được quản lý, hoặc một slug cũ của bất kỳ bài nào, là lỗi và không nói thêm gì về bài đó. Chỉ những gì tệp cung cấp và
khác đi mới được ghi: khoá thiếu hoặc để trống giữ nguyên giá trị đã lưu, nên một tệp ngắn không bao giờ xoá chuyên mục, thẻ hay mô
tả. Dòng `tags` thay toàn bộ các thẻ của bài. Ngôn ngữ không bao giờ đổi: một tệp có ngôn ngữ khác với bài là lỗi (cùng ngôn ngữ,
hoặc không nêu, thì được). Khi tiêu đề, mô tả hoặc nội dung đổi, văn bản bị thay được giữ lại thành một phiên bản cũ mà bạn có thể
khôi phục trong trình soạn thảo, kể cả khi bài vừa được lưu cách đây ít phút; chỉ đổi chuyên mục hoặc thẻ thì không ghi phiên bản
nào. Thay đổi một bài **đã đăng** có hiệu lực ngay: phần xem thử cảnh báo và không chọn sẵn, nên chỉ chọn khi bạn thật sự muốn. Nếu
một bản nháp được đăng, hoặc một bài được sửa, giữa lúc xem thử và lúc xác nhận, không có gì được ghi và bạn được yêu cầu xem thử
lại.

**Ảnh bìa.** Gói ZIP có thể mang ảnh bìa của bài: `cover: assets/cover.png` (JPEG, PNG hoặc WebP) và dòng `cover_alt` tuỳ chọn là văn bản
thay thế, viết trong phần đầu tệp. Bài mới nhận ảnh đó làm ảnh bìa. Bài đã có cũng nhận ảnh đó, **và ảnh mới thay ảnh bìa bài đang có**:
gói được ưu tiên, giống như tải ảnh lên mới trong trình soạn thảo thay ảnh bìa. Xem thử báo trường hợp nào xảy ra (bài chưa có ảnh bìa, hoặc
ảnh bìa sẽ bị thay) và coi một tệp chỉ khác ở ảnh bìa là **sẽ thay đổi**. Ảnh bìa có cùng nội dung ảnh và cùng văn bản thay thế với ảnh bìa
đã lưu thì không phải là thay đổi. Dòng `cover` trong tệp Markdown thường, đường dẫn không có trong gói, và tệp không phải ảnh JPEG, PNG
hay WebP đều là vấn đề của tệp, và tệp chưa được nhập cho đến khi sửa xong. Ảnh bìa được tính là đã dùng, không phải ảnh thừa. Nếu ảnh bìa
đổi giữa lúc xem thử và lúc nhập, không có gì được ghi và bạn được yêu cầu xem thử lại. Tác giả cũng đặt được ảnh bìa cho bài của mình
bằng cách này, như trong trình soạn thảo.

**Tệp không mang theo gì.** Tác giả (luôn là người nhập), ngày đăng, ảnh tải lên trong bài, bình luận, lượt thích,
lượt xem và các phiên bản cũ. `status` và `featured` trong tệp bị bỏ qua (nhập bài không bao giờ đặt hay bỏ nổi bật và không đổi thứ
hạng của bài). Một gói tải về bằng **Tải gói ZIP** rồi nhập lại trên cùng site là **không đổi** khi bài không có ảnh trong nội dung (ảnh bìa không tính: cùng một ảnh bìa là không thay đổi; bài có ảnh trong nội dung thì xem thử báo **sẽ thay đổi**, vì nó so văn bản như đã viết, `assets/...` với địa chỉ ảnh đã lưu; không có gì khác); những gì nó không khôi phục được là cờ và
thứ hạng nổi bật, các bản dịch nháp và các ngày, và tiêu đề, mô tả hay tên thẻ được giữ trên một dòng. Các khoá series của
gói chỉ có khi bài thuộc một series ở một phần đã khai báo, và chỉ nhập bài của quản trị viên mới dùng chúng. Chuyên mục và thẻ được tìm theo tên, không phân biệt hoa
thường, kể cả giữa các ngôn ngữ; tên chưa có thì được tạo; tên khớp với nhiều hơn một là lỗi. Nhật ký nhập lưu ai, khi nào, bao
nhiêu tệp và mã băm của từng tệp, cùng các bài đã ghi, không bao giờ lưu văn bản.

**Series từ một lần nhập (quản trị viên).** Ba khoá trong phần đầu tệp đưa một bài vào series mà không cần vào trang Series:
`series` (tên), `series_part` (số thứ tự của bài này) và `series_description` (đặt mô tả cho series mới và điền mô tả còn trống của series đã có; mô tả đã có chữ thì không bao giờ bị đổi). Viết theo thứ tự nào
cũng được. Chỉ tệp của quản trị viên dùng các khoá này; với tác giả chúng được kiểm tra rồi bỏ qua, kèm một ghi chú ở phần xem thử.
Hãy dùng **một tên cho mọi phần**: lần nhập tìm series theo tên đó (địa chỉ web của series được tạo từ tên, nên dấu và chữ hoa chữ thường
không quan trọng), hoặc tạo series khi chưa có. Các phần có thể được nhập theo thứ tự bất kỳ, trong một lần hay nhiều lần nhập, và series
được sắp theo các số đã khai. Hai bài cùng ngôn ngữ không thể có cùng một phần. Thành viên mới là bản nháp và độc giả chỉ thấy các phần đã
đăng, nên một series chỉ đọc đúng khi các phần của nó đã được đăng: "Phần n trên m" mà độc giả thấy là thứ hạng của bài trong các phần **đã
đăng**, bằng số đã khai khi mọi phần đều đã đăng. Chi tiết và giới hạn: [post-file-format.md](../post-file-format.md#series).

**Dùng trợ lý AI.** Đưa tệp mẫu cho trợ lý cùng ghi chú của bạn và yêu cầu nó chỉ trả về tệp hoàn chỉnh. Sau đó hãy đọc bản nháp
trong trình soạn thảo trước khi đăng: việc nhập kiểm tra định dạng, không kiểm tra một khẳng định có đúng hay không.

**Chưa có.**

- Liên kết một bài với bài mà nó là bản dịch (`translation_of`): khoá được đọc và bỏ qua, và phần xem thử hiện một ghi chú; hãy dùng
  bảng Bản dịch của trình soạn thảo.
- Hoàn tác một lần nhập; hãy khôi phục văn bản bị thay từ các phiên bản cũ của bài, và xoá các bản nháp không muốn trong danh sách bài.

## Nhập gói bài viết có ảnh và các khối

Một bài cần ảnh, sơ đồ, các bước, bảng so sánh hay hộp chú ý thì được nhập dưới dạng **gói ZIP**: một bài viết Markdown cùng các ảnh
của nó, viết theo [định dạng tệp bài viết](../post-file-format.md#zip-packages) với các [khối bài viết](../content-blocks.md) (tiếng
Anh). Người viết thường là trợ lý AI: ở trang nhập bài, bấm **Tải lời nhắc soạn bài** (`/admin/posts/import/authoring-prompt`), đưa lời
nhắc cho trợ lý cùng chủ đề và tư liệu của bạn, rồi tải lên gói ZIP nó trả về. Lời nhắc được tạo từ chính các khối mà phiên bản này hỗ
trợ nên luôn đúng với hiện tại. Trợ lý được yêu cầu làm gì: xem [ai-article-authoring.md](../ai-article-authoring.md) (tiếng Anh).

1. **Tải gói lên** như mọi tệp khác (cùng trang, cùng bước xem thử, cùng quy tắc: luôn là bản nháp, không bao giờ tự đăng).
2. **Đọc thẻ của gói.** Ngoài các thông tin thường lệ, thẻ cho biết gói có bao nhiêu ảnh, bài dùng bao nhiêu và bao nhiêu ảnh không
   dùng (ảnh không dùng chỉ là ghi chú và không được lưu), và nêu các khối bài dùng ("Các khối được dùng: ..."). **Vấn đề** được liệt kê
   kèm số dòng và gợi ý dùng gì thay thế: ảnh không có trong gói, ảnh không phải JPEG, PNG hay WebP, HTML không an toàn, khối không
   tồn tại, thiếu hoặc sai thuộc tính, tiêu đề nằm trong khối. Một tệp có vấn đề không thể được chọn; hãy nhờ trợ lý sửa gói, hoặc tự
   sửa, rồi tải lên lại. Gói hoàn toàn không đọc được (kho nén không an toàn, không có bài, có hai bài) hiện là thẻ lỗi.
3. **Xem thử bài viết.** Nút này vẽ bài trong chính trang bài viết thật: đúng phần đầu bài, mục lục, các khối, kiểu chữ và tô màu mã,
   cùng ảnh trong gói. Chưa có gì được lưu; liên kết sang trang khác không mở từ bản xem thử. Các khối trông giống hệt khi bài được
   đăng.
4. **Nhập.** Bản nháp được tạo cùng các ảnh của nó, trong một bước (được cả hoặc không gì cả). Mỗi ảnh trở thành ảnh của bài (tính vào
   hạn mức ảnh và bị xoá cùng bài). Nếu hạn mức đã đầy hoặc việc xử lý ảnh đang bận, không có gì được nhập và thông báo nói rõ. Nhập
   lại cùng gói sẽ dùng lại ảnh, không tạo bản sao. Trang kết quả có liên kết mở từng bản nháp trong trình soạn thảo và trang xem thử
   đã lưu của nó.
5. **Xem lại và đăng.** Mở bản nháp, thêm chuyên mục nếu chưa có (gói đã đặt ảnh bìa nếu nó nêu một ảnh), rồi đăng. Mở lại và lưu bản nháp trong trình soạn thảo
   vẫn giữ nguyên cú pháp khối: nội dung được lưu đúng như đã viết. Khối có lỗi hiện như văn bản thường, không bao giờ mất; phần xem
   thử của trình soạn thảo và phần kiểm tra trước khi đăng liệt kê chúng kèm số dòng.

Gói được kiểm tra về an toàn trước hết: mục nén có đường dẫn không an toàn, liên kết, mã hoá, kho nén lồng nhau hay giải nén quá lớn
đều bị từ chối, và một bước kiểm tra bài báo cáo script, style, iframe hay trình xử lý sự kiện nội tuyến (trang không bao giờ chạy chúng, dù bước kiểm tra tìm thấy gì). Các giới hạn ở
[post-file-format.md](../post-file-format.md#limits) và [SECURITY.md](../SECURITY.md). Tham chiếu các khối:
[content-blocks.md](../content-blocks.md).

## Tải một bài viết thành gói ZIP

**Tải gói ZIP** lưu một bài viết thành gói ZIP theo đúng [định dạng mà phần nhập bài viết đọc](../post-file-format.md#zip-packages), nên
chuyển đổi được hai chiều: gói bạn nhập sẽ thành bài viết, và bài viết bạn tải về là một gói mà phần nhập đọc lại thành đúng bài
viết đó. Không có gì mới phải học. Nút nằm ở mục **Tải về và nhân bản** trong trình soạn bài, và mỗi dòng của danh sách bài viết
có một liên kết **Tải gói ZIP**.

- **Trong gói có gì.** `article.md` ở gốc: phần đầu tệp (`title`, `slug`, `language`, `excerpt`, `category`, `tags`, `featured`,
  `status`, `translation_of` khi bài có bản dịch đã đăng, và `series`, `series_part`, `series_description` khi bài thuộc một series
  ở một phần đã khai báo, và `cover`, `cover_alt` khi bài có ảnh bìa), rồi đến nội dung đúng như đã lưu. Ảnh của bài nằm trong `assets/`, và các liên kết ảnh trong nội dung được
  đổi thành `assets/<tên tệp>`, nên gói cũng dùng được trên site khác. Mỗi ảnh chỉ lưu một lần, với tên dễ đọc và đuôi đúng định dạng
  thật của ảnh.
- **Bản đã lưu.** Gói chứa những gì đã lưu, kể cả bản nháp. Thay đổi chưa lưu trong trình soạn không có trong gói; hãy lưu trước
  (trình soạn có nhắc). Tác giả tải được bài của mình, quản trị viên tải được mọi bài.
- **Nhập lại.** Trên cùng site, gói của bài không có ảnh trong nội dung là **không đổi** (kể cả ảnh bìa), hoặc là bản cập nhật của bài nếu bạn đã sửa; gói có ảnh trong nội dung hiện **sẽ thay đổi** dù bạn không sửa gì (chỉ khác địa chỉ ảnh trong văn bản), nên hãy xem phần xem thử trước khi xác nhận. Trên site khác, nó thành một bản
  nháp mới cùng ảnh. Chỉ các khoá của định dạng tệp được đọc; các quy tắc thường lệ của nhập bài vẫn áp dụng.
- **Ảnh bìa.** Khi bài có ảnh bìa, gói chứa ảnh đó trong `assets/` (ví dụ `assets/cover-1.png`) và `article.md` có thêm các dòng `cover:` và
  `cover_alt:`, nên nhập gói trên site khác cho bản nháp cùng ảnh bìa, cùng điểm ảnh và cùng byte. Nhập lại trên cùng site không đổi gì ở
  ảnh bìa, vì ảnh bìa đã lưu chính là ảnh đó.
- **Gói không mang theo gì.** Các ngày, bình luận, lượt thích, lượt xem, các phiên bản cũ và tác giả,
  cùng các bản dịch chưa đăng. Tiêu đề, mô tả hay tên thẻ được giữ trên một dòng, như trong mọi tệp bài viết.
- **Quá lớn.** Bài mà gói vượt giới hạn của phần nhập ([post-file-format.md](../post-file-format.md#limits)) bị từ chối kèm một thông
  báo. Ảnh không còn trong kho ảnh, hoặc quá lớn cho gói, giữ nguyên liên kết gốc.
- **Tệp Markdown cũ.** `/admin/posts/<id>/export?format=md` vẫn trả về tệp Markdown đơn mà script dành cho nhà phát triển
  `seed/push.py` đọc. Trình soạn không liên kết tới nó.

## Chủ đề, series, Bài viết hay và ảnh

- **Chủ đề** (`/admin/topics`): thêm, đổi tên, mô tả và xoá chuyên mục và thẻ, và đặt cho mỗi mục một tên và mô tả đã dịch theo
  từng ngôn ngữ. Đổi tên không bao giờ đổi slug, nên liên kết cũ vẫn dùng được. Một chuyên mục còn bài viết, kể cả bản nháp, thì
  không xoá được; thay cho nút xoá có một liên kết tới đúng những bài đó, và bạn có thể chuyển các bài sang chuyên mục khác rồi
  xoá, hoặc gộp hai chủ đề. Xoá một thẻ gỡ nó khỏi mọi bài. Các trang chuyên mục và thẻ công khai chỉ tồn tại khi còn một bài đã
  đăng.
- **Series** (`/admin/series`): một series gom các bài theo thứ tự đọc ("Phần n trên m"). Tạo nó, gán bài và sắp thứ tự các phần.
  Tên và mô tả có thể dịch. Bài của mọi ngôn ngữ có thể nằm trong một series. Một lần nhập cũng có thể tạo series và đưa bài vào đúng
  phần nó khai; khi bạn lưu thứ tự ở đây, mọi bài còn lại trong series vẫn giữ phần đã khai.
- **Bài viết hay** (`/admin/curated`): danh sách có thứ tự đứng sau `/start-here`; ba bài đã đăng đầu tiên cũng hiện ở trang chủ.
  Thêm hoặc bỏ có hiệu lực ngay; thứ tự mới cần "Lưu thứ tự".
- **Ảnh** (`/admin/gallery`): tải lên nhiều ảnh, sửa chú thích, văn bản thay thế và ngày chụp (đọc từ EXIF khi bạn để trống), ẩn
  hoặc hiện, sắp xếp lại, xoá. Ảnh bị ẩn không được liệt kê ở đâu cả.
- **Hình ảnh** được lưu trong cơ sở dữ liệu và bị giới hạn bởi `MEDIA_MAX_TOTAL_SIZE`; chỉ nhận JPEG, PNG và WebP; ảnh lớn được
  thu nhỏ (xem [CONFIGURATION.md](../CONFIGURATION.md#upload-size-limits-by-layer)).

## Bình luận, người dùng và đơn tác giả

- **Bình luận** (`/admin/comments`): mọi bình luận trên mọi bài, mới nhất trước, lọc được theo trạng thái và tìm được theo nội dung
  hoặc tác giả. Một bình luận bị ẩn có thể hiện lại; một bình luận đã xoá thì không (độc giả không còn thấy, quản trị viên vẫn
  thấy). Danh sách không bao giờ hiện email.
- **Người dùng** (`/admin/users`): tạm khoá và mở khoá tài khoản độc giả, và đổi vai trò sau khi bạn nhập lại tên đăng nhập của
  người đó. Một người dùng bị tạm khoá không còn bình luận hay thích được và bị đăng xuất ở lần tải trang kế tiếp; không có gì bị
  xoá, và bài của một tác giả bị tạm khoá rời khỏi kết quả tìm kiếm. Với một tác giả mất cả thiết bị **lẫn** mã khôi phục, "Đặt lại xác minh hai
  bước" trên dòng của họ (hỏi mã của chính bạn và cần một lần đăng nhập gần đây) xoá lần đăng ký của tác giả và đăng xuất họ; lần đăng
  nhập kế tiếp có thể đăng ký lại. Nó không áp dụng cho quản trị viên khác: đó là việc của người quản lý máy chủ.
  Đổi vai trò lên hoặc xuống quản trị viên, hoặc biến một độc giả thành tác giả, cũng hỏi **mã của chính bạn** (từ ứng dụng xác thực
  hoặc một mã khôi phục) và một lần đăng nhập trong 10 phút gần nhất: nếu trang bảo đăng nhập lại thì đăng nhập rồi làm lại. Nâng ai đó
  lên quản trị viên sẽ xoá ứng dụng xác thực của họ: ở lần đăng nhập sau họ thiết lập lại bằng mã đăng ký lấy từ máy chủ
  ([Bảo mật](../SECURITY.md#authentication-and-sessions), tiếng Anh).
- **Đơn tác giả** (`/admin/applications`): duyệt hoặc từ chối đơn xin làm tác giả. Duyệt cũng cần nhập lại tên đăng nhập và, khi việc
  duyệt biến một độc giả thành tác giả, cần mã của chính bạn và một lần đăng nhập trong 10 phút gần nhất. Một ứng viên bị từ chối có
  thể nộp lại sau 30 ngày.

Thông báo về lượt thích và bình luận trên một bài được gửi tới tài khoản của tác giả bài đó. Với các bài của chủ site, đó là tài
khoản quản trị, nên hãy liên kết tài khoản quản trị với GitHub ([CONFIGURATION.md](../CONFIGURATION.md#link-the-admin-account-to-github))
nếu bạn cũng đọc blog qua đăng nhập GitHub.

## Newsletter

Độc giả đăng ký tại `/newsletter` (có liên kết ở chân trang) mà không cần tài khoản. Mỗi bài, khi được đăng **lần đầu tiên**, được
gửi dưới dạng email văn bản thuần tới những người đã xác nhận, bằng ngôn ngữ của chính người đăng ký và chỉ với các bài thuộc ngôn
ngữ đó. Gỡ, đăng lại, sửa và bản nháp không gửi gì.

**Bài do tác giả đăng phải chờ bạn.** Email mang nội dung do tác giả viết và đi ra dưới tên site của bạn tới mọi người đăng ký, nên khi
một AUTHOR đăng bài lần đầu, newsletter của bài được **giữ lại** cho tới khi một quản trị viên quyết định. Bài do chính bạn đăng (kể cả
bài do tác giả viết) được xếp hàng ngay. Các newsletter đang giữ được liệt kê đầu trang `/admin/newsletter`, kèm tiêu đề và đoạn trích
đúng như người đăng ký sẽ đọc (đoạn trích bị cắt ở 300 ký tự), tác giả, ngôn ngữ và số người đăng ký đã xác nhận cùng ngôn ngữ sẽ nhận
được. **Duyệt gửi** xếp thư vào hàng đợi: tiêu đề, đoạn trích và ngôn ngữ bạn vừa thấy được lưu cùng với nó, nên sửa bài về sau không làm đổi
thư hay người nhận. Nếu tác giả sửa bài sau khi bạn mở trang, lần duyệt gửi bị từ chối ("bài đã được sửa"), không có gì được gửi và thẻ hiện
nội dung mới: hãy đọc lại rồi duyệt gửi lần nữa. **Từ chối** giữ lại một bản ghi và không bao giờ gửi; bài viết không bị đụng tới. Newsletter đang giữ của một bài hiện không được
đăng sẽ đợi cho tới khi bài được đăng lại. Không có hạn: newsletter đang giữ ở nguyên đó cho tới khi bạn quyết định. Việc duyệt hay từ
chối được ghi log kèm id bài và id tài khoản của bạn (không có nội dung).

| Bước | Điều xảy ra |
|---|---|
| Đăng ký | Biểu mẫu luôn nhận cùng một câu trả lời với mọi địa chỉ đúng định dạng, nên không ai dò được ai đã đăng ký. Yêu cầu không gửi email nào. |
| Email xác nhận | Một worker gửi trong khoảng 30 giây. Liên kết có hiệu lực 48 giờ. |
| Xác nhận | Liên kết chỉ hiện một nút; bấm "Xác nhận đăng ký" mới xác nhận, nên một bộ quét thư mở liên kết không đổi gì. |
| Email bài mới | Tiêu đề, mô tả ngắn, liên kết bài và liên kết huỷ đăng ký. |
| Huỷ đăng ký | Một liên kết trong mọi email (và nút một chạm của hộp thư). Không cần đăng nhập. Đăng ký lại phải xác nhận lại. |

**Dữ liệu được lưu:** địa chỉ, trạng thái của nó (đang chờ hoặc đã xác nhận), ngôn ngữ, mốc thời gian và những bài đã được gửi. Sau
khi huỷ đăng ký chỉ còn giữ một mã băm một chiều của địa chỉ để không bao giờ gửi lại. Một đăng ký đang chờ bị xoá sau 7 ngày.
Không lưu: IP hay user agent của người đăng ký và bất kỳ pixel theo dõi nào. Thất bại được thử lại sau 1 phút, 5 phút, 30 phút, 2
giờ và 12 giờ, rồi bị đánh dấu thất bại; sự cố của nhà cung cấp không bao giờ chặn việc đăng bài.

**Trang quản trị** (`/admin/newsletter`, chỉ ADMIN) hiện các newsletter đang giữ, rồi chỉ hiện số liệu, không bao giờ hiện địa chỉ:
người đăng ký theo trạng thái, các mã băm đã huỷ đăng ký, 10 lần gửi gần nhất theo bài (chờ duyệt, đã từ chối, chờ tách thư, đã tách
thư, kèm số email đã gửi, đang thử lại, thất bại và đang chờ) và lỗi theo mã.

**Gửi email bị tắt cho tới khi bạn cấu hình.** Với `NEWSLETTER_TRANSPORT=log` mặc định, site nhận đăng ký nhưng không gửi gì (khi
đó trang quản trị đếm mọi email là đã gửi). Việc gửi email thật chưa được các kiểm tra của chính dự án xác minh; hãy làm theo danh
sách kiểm trong [CONFIGURATION.md](../CONFIGURATION.md#newsletter-in-production) và thử bằng hộp thư của chính bạn trước.

## Tin nhắn liên hệ

Biểu mẫu liên hệ trong mục Liên hệ của trang chủ gửi tên, email, tiêu đề (không bắt buộc) và nội dung của khách tới backend. Mỗi
tin nhắn được **lưu trước**, nên không mất dù email tắt hay gửi lỗi. Hộp thư là `/admin/contact` (chỉ ADMIN; một AUTHOR thấy trang
"chỉ dành cho quản trị viên"), mới nhất trước, 20 tin mỗi trang.

| Bạn thấy hoặc làm gì | Cách hoạt động |
|---|---|
| Một tin nhắn | Tên, email dạng liên kết mở chương trình thư của bạn, tiêu đề (hoặc "không có tiêu đề"), ngày giờ theo UTC, ngôn ngữ của trang đã gửi, và toàn bộ nội dung với các dòng xuống hàng của khách. Nội dung luôn hiện dưới dạng văn bản thuần, không bao giờ là HTML hay Markdown. |
| Chưa đọc | Tin mới có nhãn "Chưa đọc" và một vạch bên trái. Đầu trang đếm số tin chưa đọc của cả hộp thư, không chỉ của trang bạn đang xem. |
| Đánh dấu đã đọc | Nút trên tin chưa đọc. Nó chỉ đổi nhãn; không có gì được gửi tới khách. |
| Xoá | Hỏi xác nhận, rồi xoá hẳn tin nhắn. Không khôi phục được. |

**Bản sao qua email:** đặt `CONTACT_RECIPIENT` trong `.env` là một địa chỉ thì mỗi tin mới còn được gửi tới đó dạng văn bản thuần,
với địa chỉ của khách làm `Reply-To`, để bạn trả lời ngay từ hộp thư. Để trống thì chỉ đọc tin trong hộp thư quản trị. Email đi theo
`NEWSLETTER_TRANSPORT`: với `log` mặc định thì không gửi gì. Mọi thiết lập và giới hạn (5 tin mỗi giờ cho mỗi địa chỉ của khách và mỗi địa chỉ email, 60 tin cho cả site) nằm trong
[CONFIGURATION.md](../CONFIGURATION.md#contact-form). Site không bao giờ ghi log tên, địa chỉ hay nội dung tin nhắn; việc trả lời do bạn
làm, blog không gửi câu trả lời.

**Thời hạn lưu và xoá dữ liệu của một người.** Tin nhắn là dữ liệu cá nhân nên không được giữ mãi: mỗi đêm một tác vụ xoá các tin cũ hơn
`CONTACT_RETENTION_DAYS` ngày (mặc định 365), đã đọc hay chưa; đặt `0` để giữ mọi tin cho tới khi bạn xoá. Để xoá dữ liệu của một người
sớm hơn, xoá các tin của họ ở đây, gỡ địa chỉ nhận bài qua email của họ bằng liên kết huỷ đăng ký trong bất kỳ thư nào (hoặc nhờ họ làm),
và với một tài khoản độc giả thì nhờ chủ site: hiện chưa có chức năng tự xoá tài khoản.

## Thống kê và quyền riêng tư

`/admin/analytics` hiện **lượt xem đã ghi nhận** trong một khoảng ngày (mặc định 30 ngày gần nhất, tối đa 366): tổng trong khoảng
và từ trước tới nay, một biểu đồ và một bảng theo ngày, 10 bài được đọc nhiều nhất và sáu nhóm nguồn (nội bộ, tìm kiếm, mạng xã
hội, GitHub, khác, trực tiếp). Một ADMIN thấy cả site; một AUTHOR chỉ thấy các bài của mình. Không có số liệu tổng hợp nào công
khai ngoài số lượt xem của chính từng bài.

Cái gì được lưu và cái gì không:

| Được lưu | Không được lưu |
|---|---|
| Tổng từ trước tới nay của mỗi bài. | Địa chỉ IP, user agent. |
| Một bộ đếm cho mỗi bài, ngày và nhóm nguồn (tối đa 6 dòng mỗi bài mỗi ngày, giữ vô thời hạn). | URL hay host của trang giới thiệu, query string. |
| | Định danh phiên hay khách, cookie, một dòng cho mỗi lượt xem. |

Lưu ý: chỉ số là "lượt xem đã ghi nhận", không phải khách truy cập duy nhất (không có định danh khách thì không đếm trung thực
được). Một lượt xem chỉ tính một lần cho mỗi bài trong mỗi phiên tab trình duyệt, lặp lại trong 30 phút được gộp, và áp dụng giới
hạn 30 beacon mỗi phút cho mỗi IP; điều này được quyết định trong bộ nhớ của máy chủ Next và không có gì về khách truy cập đến được
cơ sở dữ liệu. Lọc bot làm giảm bot nhưng không loại bỏ hết. Chuỗi theo ngày bắt đầu từ ngày tính năng được triển khai, và ranh
giới ngày theo `ANALYTICS_TIME_ZONE` (hãy đặt múi giờ của riêng bạn trên một bản cài mới; đổi sau này không dời các ngày đã ghi).

## Tìm kiếm

Độc giả tìm kiếm từ khung tìm nhanh (nhấn `/` hoặc Ctrl/Cmd cộng K) và từ `/search`. Kết quả gồm bài viết, chủ đề, series, case
study, tác giả và các trang, theo ngôn ngữ của trang họ đang xem, và không bao giờ có bản nháp, bài đã gỡ hay bài của một tác giả
bị tạm khoá.

Tìm kiếm PostgreSQL không có gì phải cấu hình. Công cụ Meilisearch tuỳ chọn, thứ tự bật, reindex và trạng thái nằm ở
[CONFIGURATION.md](../CONFIGURATION.md#search-with-meilisearch); reindex và trạng thái là các lệnh gọi API của quản trị viên, không
có màn hình cho chúng. Danh sách bài của trang quản trị có ô tìm kiếm riêng không phân biệt dấu.
