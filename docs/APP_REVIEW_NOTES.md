# App Review Notes

WingDex is passwordless and does not have a shared username and password. Reviewers can create an isolated account in the app with either:

1. **Continue with Apple**, then complete the standard Sign in with Apple flow.
2. **Continue with a Passkey > Sign up**, then create a passkey when prompted.

Google and GitHub sign-in are also available. No subscription or purchase is required. Production backend services will remain available throughout review.

## Core review flow

1. Sign up with Apple or a passkey.
2. On Home, tap **Upload & Identify**, or tap the camera button in the bottom navigation.
3. Choose one or more bird photos from the system photo picker.
4. Review the suggested outing date and location, then confirm or edit each bird identification.
5. Save the result. The identified species appears in **WingDex**, and the saved outing appears in **Outings**.
6. Tap the account avatar to open Settings and review import/export, passkey management, location controls, privacy links, and data management.

The account starts empty. The App Store build does not contain a reviewer-only demo mode or shared demo credentials, so testing identification requires selecting a bird photo from the review device's photo library.

## Privacy and location

Bird-photo identification runs entirely on the device after the model is available. Photo image contents are not uploaded to WingDex.

When **Use Location and Time** is enabled, WingDex uses photo location and month on the device to improve identification. Exact coordinates may be saved with the outing and photo metadata. Outing name suggestions are resolved on WingDex servers from an OpenStreetMap-derived database; coordinates are not sent to a third party for this. Typed place searches are still forwarded to Geoapify. The location editor always shows a linked **Powered by Geoapify and OpenStreetMap** caption.

## Account deletion

To delete the account in the app:

1. Tap the account avatar.
2. Open **Delete Data...** under Data Management.
3. Tap **Delete Account & All Data** and complete both confirmations.

Deletion removes the WingDex account, sessions, passkeys, outings, observations, species data, and linked provider credentials. The user is signed out when deletion completes.

## Share extension

To test the share extension:

1. Select one or more images in Photos.
2. Open the system share sheet and choose **WingDex**.
3. Wait for the extension to finish staging the photos, tap **Done**, then open WingDex.
4. WingDex opens the normal photo review and identification flow with the shared images.

Shared image files are staged locally in the WingDex app group for this handoff. They are not uploaded for bird identification.