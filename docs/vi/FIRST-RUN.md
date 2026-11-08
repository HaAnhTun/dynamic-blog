# Lần chạy đầu tiên

Bạn đã cài xong bộ dịch vụ ([INSTALL.md](INSTALL.md)). Trang này đưa một site mới, chưa có ai làm chủ, tới bài viết đầu tiên được
đăng. Bản tiếng Anh: [../FIRST-RUN.md](../FIRST-RUN.md).

## Nội dung

- [Bản cài mới là gì](#bản-cài-mới-là-gì)
- [Tìm mã thiết lập](#tìm-mã-thiết-lập)
- [Nhận quyền sở hữu site tại /setup](#nhận-quyền-sở-hữu-site-tại-setup)
- [Bật xác minh hai bước](#bật-xác-minh-hai-bước)
- [Tên site và ngôn ngữ](#tên-site-và-ngôn-ngữ)
- [Nạp nội dung mẫu](#nạp-nội-dung-mẫu)
- [Viết bài đầu tiên](#viết-bài-đầu-tiên)
- [Khi có gì đó không ổn](#khi-có-gì-đó-không-ổn)

## Bản cài mới là gì

Một cơ sở dữ liệu chưa có nội dung và một tài khoản quản trị được tạo sẵn mà chưa ai đụng tới được gọi là bản cài mới. Không ai
đăng nhập được bằng mật khẩu mặc định: mật khẩu phát triển được tạo sẵn bị khoá lúc khởi động (`SETUP_LOCK_DEV_SEED`, mặc định
bật). Cho tới khi site được nhận quyền sở hữu, `/setup` mở và mọi thứ khác vẫn chạy: các trang công khai hiện nội dung giữ chỗ trung
tính bằng cả hai ngôn ngữ, còn trang quản trị từ chối mọi lần đăng nhập.

Bạn nhận quyền sở hữu site một lần, bằng một **mã thiết lập** mà chỉ người có quyền truy cập máy chủ mới đọc được. Sau đó `/setup`
trả về 404 vĩnh viễn. Một bản triển khai có từ trước khi có cơ chế này được chuyển sang trạng thái đã thiết lập và không bao giờ
nhận quyền sở hữu lại được.

## Tìm mã thiết lập

Backend quyết định mã lúc khởi động:

- Nếu bạn đặt `SETUP_TOKEN` trong `.env` (ít nhất 24 ký tự, và nên dài và ngẫu nhiên: `openssl rand -hex 32`), giá trị đó là mã.
- Nếu không, nó tạo một mã ngẫu nhiên và ghi vào tệp `setup-code` trong thư mục dữ liệu của nó (`SETUP_DATA_DIR`, là `/data` trong
  compose, một volume có tên). Log của backend in ra **đường dẫn** của tệp đó, không bao giờ in mã.

Với bản cài bằng compose, đọc mã bằng:

```bash
docker compose exec -T backend sh -c 'cat /data/setup-code'
```

(Không có `-T` bạn cũng nhận được cùng kết quả trong một terminal.) Trên máy phát triển chạy bằng `mvn spring-boot:run`, tệp nằm ở
`backend/data/setup-code`. Tệp chỉ đọc được bởi người dùng của backend và bị xoá khi thiết lập hoàn tất. Hãy giữ thư mục dữ liệu ở
chế độ riêng tư: backend tin một tệp mã mà nó tìm thấy ở đó.

## Nhận quyền sở hữu site tại /setup

Mở `<SITE_URL>/setup`, ví dụ <http://localhost:3000/setup>. Thêm `?lang=en` hoặc `?lang=vi` để chọn ngôn ngữ trang ở lần truy cập
đầu. Biểu mẫu "Thiết lập blog của bạn" yêu cầu:

| Trường | Quy tắc |
|---|---|
| Mã thiết lập | Giá trị bạn vừa đọc ở trên. |
| Tên hiển thị | 1 tới 60 ký tự. Hiện làm tên tác giả của các bài của bạn. |
| Email | Một địa chỉ hợp lệ. Nó trở thành email đăng nhập quản trị của bạn. |
| Mật khẩu | 12 tới 128 ký tự, không phải mật khẩu phổ biến, không gồm toàn ký tự lặp hoặc liên tiếp, và không chứa phần đầu email của bạn ([quy tắc](../SECURITY.md#password-policy), tiếng Anh). Băm bằng Argon2id; không bao giờ lưu hay ghi log ở dạng rõ. |
| Nhập lại mật khẩu | Phải khớp. |

Bấm **Tạo tài khoản**. Khi thành công, tài khoản quản trị được tạo sẵn trở thành của bạn (cùng một tài khoản, email và mật khẩu
mới), mọi phiên mà tài khoản đó có trước đó đều kết thúc (cả refresh token lẫn access token), tệp mã bị xoá, `/setup` trả về 404 từ
đó trở đi, và trình duyệt chuyển tới `/admin/login`. Hãy đăng nhập ở đó bằng email và mật khẩu bạn vừa chọn; phần kế tiếp mô tả
những gì xảy ra sau đó.

Cần biết:

- Backend giới hạn số lần thử thiết lập theo địa chỉ client (5 lần mỗi phút, tính mọi lần thử) và đếm các mã sai cho toàn bộ tiến trình (120 lần mỗi phút; vượt mức đó
  một mã sai nhận 429): mã đúng không bao giờ bị từ chối vì bộ đếm này, nên một đợt dồn dập không thể chặn bạn. Nếu có người dồn dập gọi `/setup`, hãy nhận quyền sở hữu
  instance thật sớm, hoặc đặt `ADMIN_PASSWORD` trong `.env` và khởi động lại: cách đó nhận quyền sở hữu instance qua biến môi trường và đóng `/setup`.
- Đặt `ADMIN_PASSWORD` hoặc `ADMIN_GITHUB_ID` trong `.env` trước lần khởi động đầu thì instance được nhận quyền sở hữu theo cách đó,
  và `/setup` đóng ngay từ đầu. `ADMIN_GITHUB_ID` cũng đóng `/setup`, nên nếu chưa cấu hình đăng nhập GitHub thì hãy dùng
  `ADMIN_PASSWORD`.
- Mã sai sẽ báo "Mã thiết lập không đúng."; mã không bao giờ xuất hiện trong bất kỳ log nào.
- Hãy mở `/setup` bằng chính địa chỉ bạn sẽ dùng cho site. Với site công khai đó là địa chỉ `https://` của bạn.

## Bật xác minh hai bước

Tài khoản quản trị cần bước thứ hai, nên lần đăng nhập đầu tiên chưa mở khu vực quản trị. Sau mật khẩu, trang yêu cầu bạn thiết lập
một ứng dụng xác thực (mọi ứng dụng hỗ trợ mã theo thời gian, ví dụ ứng dụng trên điện thoại của bạn):

1. Bấm **Hiện khoá thiết lập**, rồi thêm khoá vào ứng dụng (gõ tay, bấm **Sao chép**, hoặc mở liên kết ngay trên điện thoại; không có
   ảnh QR). Ứng dụng bắt đầu hiện mã 6 chữ số đổi mỗi 30 giây.
2. Nhập mã hiện tại. Ở đây không hỏi mã đăng ký: bạn vừa chứng minh mình đọc được máy chủ (mã thiết lập), và trong một giờ kế tiếp việc
   đăng ký được mở cho tài khoản này. Hãy làm ngay, đừng để sang ngày mai.
3. Trang hiện **mười mã khôi phục, chỉ một lần**. Hãy tải về hoặc sao chép, cất ở nơi tách khỏi điện thoại (trình quản lý mật khẩu), rồi
   đánh dấu ô thì nút **Vào khu vực quản trị** mới bấm được. Một mã khôi phục thay cho một mã 6 chữ số, dùng một lần; đó là thứ bạn
   dùng khi mất điện thoại.

Từ giờ mỗi lần đăng nhập là mật khẩu, rồi mã. Các thiết bị khác của bạn đã bị đăng xuất khi đăng ký. Để đổi điện thoại, tạo mã khôi
phục mới hoặc đổi mật khẩu, mở mục Bảo mật trong khu vực quản trị ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#bảo-mật-xác-minh-hai-bước-và-mật-khẩu)).
Hãy sao `MFA_ENCRYPTION_KEY` trong `.env` sang một nơi an toàn: bản sao lưu cơ sở dữ liệu không chứa nó, và thiếu nó thì không đọc được
các lần đăng ký ([BACKUP-AND-RESTORE.md](../BACKUP-AND-RESTORE.md#what-to-back-up), tiếng Anh).

Nếu bạn đặt `ADMIN_PASSWORD` hoặc `ADMIN_GITHUB_ID` thay vì dùng `/setup`, lần đăng nhập đầu hỏi **mã đăng ký**: đọc nó bằng
`docker compose exec backend cat /data/mfa-enrollment-code` (hoặc dùng giá trị của `MFA_ENROLLMENT_TOKEN`).

## Tên site và ngôn ngữ

**Tên site, khẩu hiệu và mọi thứ về bạn** là nội dung site, lưu trong cơ sở dữ liệu và sửa theo từng ngôn ngữ ở **Quản trị, Cài
đặt** (`/admin/settings`, trang "Nội dung site"). Bắt đầu với mục **Chung** (tên site, khẩu hiệu, câu định vị), rồi **Hồ sơ và phần
chào**, **Giới thiệu**, **Liên hệ** và các mục còn lại. Cho tới khi bạn lưu một mục, các trang công khai hiện giá trị mặc định
trung tính như "Your Site Name". Mỗi mục được lưu theo từng ngôn ngữ: đổi "Ngôn ngữ của nội dung" ở đầu trang Cài đặt và điền cả
hai. Một mục chỉ lưu bằng một ngôn ngữ sẽ được hiện ở site của ngôn ngữ kia bằng bản của ngôn ngữ mặc định, và khi cả hai đều
chưa lưu thì bằng các giá trị mặc định đi kèm. Bạn cũng có thể điền nhiều mục cùng lúc từ một tệp Markdown, xem
[ADMIN-GUIDE.md](ADMIN-GUIDE.md#nhập-từ-tệp-markdown).

**Ngôn ngữ không đặt trong trình duyệt.** Site nói hai ngôn ngữ, tiếng Anh và tiếng Việt. Ngôn ngữ nào là mặc định (URL của nó
không có tiền tố `/vi` hay `/en`) đã được quyết định khi bạn chạy `init-env` (`DEFAULT_LOCALE`) và được đóng vào image frontend:
muốn đổi thì sửa `.env` và chạy `docker compose up -d --build`. Trang Cài đặt hiện ngôn ngữ mặc định và các ngôn ngữ đang bật ở
chế độ chỉ đọc. Đặt đúng ngay từ ngày đầu là dễ nhất, vì đổi ngôn ngữ mặc định về sau sẽ làm thay đổi những URL nào có tiền tố.
Xem thêm ở [CONTENT-AND-I18N.md](../CONTENT-AND-I18N.md) (tiếng Anh).

## Nạp nội dung mẫu

Một site mới còn trống. Mở **Quản trị, Cài đặt** và dùng khung **Nội dung mẫu**: nút **Nạp nội dung mẫu** thêm

- bốn bài viết đã đăng: một bài "chào mừng" và một bài "viết bằng Markdown", mỗi bài có bản tiếng Anh và bản tiếng Việt, liên kết
  làm bản dịch của nhau;
- series "Bắt đầu" (có tên và mô tả đã dịch) chứa các bài của mỗi ngôn ngữ;
- chuyên mục "Hướng dẫn" và các thẻ "welcome" và "markdown", có tên tiếng Việt.

Các bài được viết cho mục đích này, trung tính, không có ảnh và minh hoạ các tính năng Markdown mà site hiển thị. Chúng thuộc về
bạn (bạn là tác giả) và bạn có thể sửa hoặc xoá từng mục. Bấm nút lần nữa không bao giờ tạo trùng: nó báo đã tạo gì và giữ nguyên
gì. Chỉ quản trị viên (ADMIN) làm được việc này (`POST /api/v1/admin/sample-content`).

Có một điều cần biết: mỗi bài được đăng lần đầu đều xếp một lượt gửi newsletter vào hàng đợi, như mọi lần đăng. Trên một site
mới chưa có người đăng ký nên không có gì được gửi; trên một site đã có người đăng ký, việc nạp các bài mẫu sẽ thông báo chúng.
Hãy nạp nội dung mẫu trước khi mở newsletter cho độc giả, và xoá các bài mẫu khi bạn không cần nữa.

Các trang công khai hiện bài mới trong khoảng thời gian cache nếu thay đổi được thực hiện bên ngoài trang quản trị; thay đổi làm
trong trang quản trị (kể cả nút này) hiện ngay.

## Viết bài đầu tiên

1. Mở **Quản trị, Bài viết** và bấm **Viết bài** (`/admin/posts/new`).
2. Chọn ngôn ngữ của bài, viết tiêu đề, mô tả ngắn và nội dung bằng Markdown. Một bài cần có chuyên mục trước khi đăng được; hãy tạo
   ngay trong trình soạn thảo nếu bạn chưa có. Thẻ không bắt buộc.
3. Lưu (Ctrl hoặc Cmd cộng S). **Đăng bài** sẽ lưu trước nếu còn thay đổi chưa lưu rồi mới đăng. Cho tới lúc đó bài là bản nháp mà
   chỉ bạn và các quản trị viên khác thấy.
4. Mở bài trên site công khai. Để cung cấp bài ở ngôn ngữ còn lại, dùng khung **Bản dịch** trong trình soạn thảo
   ([ADMIN-GUIDE.md](ADMIN-GUIDE.md#bài-viết-và-bản-dịch)).

## Khi có gì đó không ổn

| Triệu chứng | Nguyên nhân có thể |
|---|---|
| Trang nhập mã từ chối một mã trông đúng | Đồng hồ lệch. Bật giờ tự động trên điện thoại và kiểm tra giờ của máy chủ ([TROUBLESHOOTING.md](../TROUBLESHOOTING.md#two-step-codes-are-rejected), tiếng Anh). |
| `/setup` hiện 404 | Site đã được nhận quyền sở hữu (hoặc `ADMIN_PASSWORD` hay `ADMIN_GITHUB_ID` đã được đặt). Hãy đăng nhập ở `/admin/login`. Nếu bạn mất mật khẩu, xem [TROUBLESHOOTING.md](../TROUBLESHOOTING.md). |
| `cat: can't open '/data/setup-code'` | Tệp mã không tồn tại: site đã được nhận quyền sở hữu, hoặc `SETUP_TOKEN` được đặt (khi đó giá trị đó là mã), hoặc backend chưa khởi động xong (`docker compose logs backend`). |
| Đăng nhập ở `/admin/login` không làm gì | Qua HTTP thường trên một địa chỉ không phải localhost, trình duyệt bỏ các cookie `secure`. Hãy dùng `https://` hoặc `http://localhost:3000`. Cũng nên mở site đúng host của `SITE_URL`. |
| Mọi lần đăng nhập đều bị từ chối | Dùng email bạn đã nhập ở `/setup`, không phải `admin@blog.local`. |
| Các trang hiện `localhost` trong liên kết hoặc sitemap | `SITE_URL` sai lúc image frontend được build. Sửa `.env` và chạy `docker compose up -d --build`. |

Xem thêm ở [TROUBLESHOOTING.md](../TROUBLESHOOTING.md) (tiếng Anh).
