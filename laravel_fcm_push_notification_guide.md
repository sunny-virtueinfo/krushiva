# Laravel Firebase Push Notifications Guide

This document outlines the steps required to implement Firebase Cloud Messaging (FCM) push notifications in your Laravel backend. This is designed to integrate with the existing React Native frontend, which already expects an endpoint to save device tokens.

## 1. Prerequisites

1.  **Firebase Project**: Ensure you have a Firebase project created in the [Firebase Console](https://console.firebase.google.com/).
2.  **Service Account Key**:
    *   Go to Firebase Console -> Project Settings -> Service Accounts.
    *   Click "Generate new private key".
    *   Save the downloaded `.json` file securely. Do not commit this file to version control.
    *   Place it in your Laravel project, for example at `storage/app/firebase/service-account.json`.

## 2. Database Setup

You need to store the FCM device tokens sent by the React Native app. You can either add a column to your `users` table or create a separate table for multiple devices per user.

### Option A: Add to `users` table (Single device per user)

```bash
php artisan make:migration add_fcm_token_to_users_table
```

In the migration file:
```php
public function up()
{
    Schema::table('users', function (Blueprint $table) {
        $table->string('fcm_token')->nullable();
    });
}
```

### Option B: Separate `device_tokens` table (Multiple devices per user)

```bash
php artisan make:migration create_device_tokens_table
```

In the migration file:
```php
public function up()
{
    Schema::create('device_tokens', function (Blueprint $table) {
        $table->id();
        $table->foreignId('user_id')->constrained()->onDelete('cascade');
        $table->string('token');
        $table->string('device_type')->nullable(); // 'ios' or 'android'
        $table->timestamps();
    });
}
```
*Run `php artisan migrate` after creating the migration.*

## 3. Package Installation (Recommended)

The easiest way to integrate Firebase into Laravel is using the official Firebase SDK for PHP or a robust wrapper like `kreait/laravel-firebase`.

```bash
composer require kreait/laravel-firebase
```

Publish the configuration:
```bash
php artisan vendor:publish --provider="Kreait\Laravel\Firebase\ServiceProvider" --tag=config
```

### Configuration (`.env`)

Add the path to your service account credentials in your `.env` file:

```env
FIREBASE_CREDENTIALS=storage/app/firebase/service-account.json
```

## 4. API Endpoints

The React Native application needs an endpoint to send the token.

### Create Controller
```bash
php artisan make:controller Api/FcmController
```

### `app/Http/Controllers/Api/FcmController.php`

```php
<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;

class FcmController extends Controller
{
    public function saveToken(Request $request)
    {
        $request->validate([
            'token' => 'required|string',
        ]);

        $user = $request->user();

        // Option A: Single token per user
        $user->update(['fcm_token' => $request->token]);

        // Option B: Multiple tokens per user
        // $user->deviceTokens()->updateOrCreate(
        //     ['token' => $request->token],
        //     ['device_type' => $request->header('User-Agent')] 
        // );

        return response()->json([
            'message' => 'FCM token saved successfully.',
        ]);
    }
}
```

### Define Route (`routes/api.php`)

```php
use App\Http\Controllers\Api\FcmController;

Route::middleware('auth:sanctum')->group(function () {
    Route::post('/fcm/save-token', [FcmController::class, 'saveToken']);
});
```

## 5. Sending Notifications

You can create a service or a Laravel Notification class to handle sending messages.

### Example: Using a Service Class

```bash
php artisan make:class Services/FirebaseService
```

### `app/Services/FirebaseService.php`

```php
<?php

namespace App\Services;

use Kreait\Firebase\Contract\Messaging;
use Kreait\Firebase\Messaging\CloudMessage;
use Kreait\Firebase\Messaging\Notification;
use Illuminate\Support\Facades\Log;

class FirebaseService
{
    protected $messaging;

    public function __construct(Messaging $messaging)
    {
        $this->messaging = $messaging;
    }

    public function sendPushNotification($fcmToken, $title, $body, $data = [])
    {
        if (!$fcmToken) {
            return false;
        }

        try {
            $notification = Notification::create($title, $body);

            $message = CloudMessage::withTarget('token', $fcmToken)
                ->withNotification($notification)
                ->withData($data);

            $this->messaging->send($message);
            return true;
            
        } catch (\Exception $e) {
            Log::error('Firebase Push Notification Error: ' . $e->getMessage());
            return false;
        }
    }
}
```

### Usage Example (e.g., inside an Event Listener or Controller)

```php
use App\Services\FirebaseService;

// Inject the service
public function notifyUser(FirebaseService $firebaseService, $user)
{
    $title = "New Message!";
    $body = "You have received a new chat request.";
    $data = [
        'type' => 'chat_request',
        'id'   => '123'
    ];

    $firebaseService->sendPushNotification($user->fcm_token, $title, $body, $data);
}
```

## 6. Testing

1.  Log in on the React Native app. It should automatically hit `POST /api/fcm/save-token` and store the token in your database.
2.  Use the `FirebaseService` in a Tinker session or a test route to send a notification to that specific token.
3.  Ensure the React Native app receives the notification in both the foreground and background.

## 7. WebView to React Native Communication

To ensure the React Native app can save the FCM token, the WebView (your website) must communicate successful login and logout events to the mobile wrapper.

### On Login Success
Add this JavaScript to your website's login success handler:

```javascript
if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'LOGIN_SUCCESS',
        token: 'YOUR_BEARER_TOKEN_HERE', // The user's API token
        user: { id: 1, name: 'John Doe' } // Optional user data
    }));
}
```

### On Logout
Add this JavaScript to your logout handler:

```javascript
if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'LOGOUT'
    }));
}
```
