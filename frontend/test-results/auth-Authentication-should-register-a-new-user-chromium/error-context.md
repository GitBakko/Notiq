# Page snapshot

```yaml
- generic [ref=e4]:
  - heading "Create your account" [level=2] [ref=e6]
  - generic [ref=e7]:
    - generic [ref=e8]:
      - textbox "Full Name (Optional)" [ref=e10]: Test User
      - textbox "Email address" [ref=e12]: test-469c30e7-a3b7-47d1-b986-1b1a9e405069@example.com
      - textbox "Password" [ref=e14]: password123
      - textbox "Invitation Code" [active] [ref=e16]
    - button "Sign up" [ref=e18] [cursor=pointer]
    - link "Already have an account? Sign in" [ref=e20] [cursor=pointer]:
      - /url: /login
```