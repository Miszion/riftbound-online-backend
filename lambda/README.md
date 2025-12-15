# Lambda Functions - TypeScript

All Lambda functions are now written in **TypeScript** for type safety and better developer experience.

## Functions

### 1. sign_in (`sign_in/index.ts`)
Handles user authentication with email and password.

**Handler**: `dist/index.handler`

**Request**:
```typescript
{
  "email": "user@example.com",
  "password": "SecurePass123!"
}
```

**Response**:
```typescript
{
  "idToken": "eyJ...",
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "expiresIn": 3600
}
```

### 2. sign_up (`sign_up/index.ts`)
Handles user registration.

**Handler**: `dist/index.handler`

**Request**:
```typescript
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "username": "username"
}
```

**Response**:
```typescript
{
  "message": "User signed up successfully",
  "userId": "uuid",
  "userConfirmed": false
}
```

### 3. refresh_token (`refresh_token/index.ts`)
Handles JWT token refresh.

**Handler**: `dist/index.handler`

**Request**:
```typescript
{
  "refreshToken": "..."
}
```

**Response**:
```typescript
{
  "idToken": "eyJ...",
  "accessToken": "eyJ...",
  "expiresIn": 3600
}
```

## Building

### Build All Functions

```bash
# From project root
bash lambda/build.sh

# Or from lambda directory
cd lambda
./build.sh
```

This will:
1. Install dependencies
2. Compile TypeScript to JavaScript
3. Create zip files ready for AWS Lambda

### Build Individual Function

```bash
cd lambda/sign_in
npm install
npm run build
npm run bundle
```

### Development

Each function has a dedicated `tsconfig.json` and `package.json`:

```bash
cd lambda/sign_in

# Install dependencies
npm install

# Watch for changes
npm run watch

# Build
npm run build
```

## Environment Variables

Each Lambda function expects:
- `COGNITO_USER_POOL_ID` - Cognito User Pool ID
- `COGNITO_CLIENT_ID` - Cognito App Client ID

These are automatically set by the CDK stack in `cdk/src/auth-stack.ts`.

## Error Handling

All functions return consistent error responses:

```typescript
{
  "statusCode": 400|401|403|404|409|500,
  "body": {
    "error": "Error message",
    "code": "CognitoErrorCode"
  },
  "headers": {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  }
}
```

### Status Codes

- **400**: Bad request (missing fields, invalid parameters)
- **401**: Unauthorized (invalid credentials, expired token)
- **403**: Forbidden (user not confirmed)
- **404**: Not found (user doesn't exist)
- **409**: Conflict (email already registered)
- **500**: Server error

## Type Definitions

All functions include TypeScript interfaces for type safety:

```typescript
interface SignInRequest {
  email: string;
  password: string;
}

interface AuthenticationResult {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface ApiResponse<T> {
  statusCode: number;
  body: string;
  headers: {...}
}
```

## Output Files

After building, you'll have:

```
lambda/
├── sign_in/
│   ├── index.ts
│   ├── dist/
│   │   ├── index.js
│   │   ├── index.js.map
│   │   └── index.d.ts
│   ├── node_modules/
│   └── package.json
├── sign_in.zip          ← Ready for Lambda
├── sign_up.zip          ← Ready for Lambda
└── refresh_token.zip    ← Ready for Lambda
```

## CDK Integration

The CDK stack (`cdk/src/auth-stack.ts`) automatically:
1. References the compiled Lambda code
2. Sets environment variables
3. Creates IAM roles and policies
4. Creates API Gateway endpoints
5. Deploys everything to AWS

The handler path is set to `dist/index.handler` to point to the compiled JavaScript output.

## Debugging

### View Logs

```bash
# Real-time logs
aws logs tail /aws/lambda/riftbound-dev-sign-in --follow

# Query logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/riftbound-dev-sign-in \
  --start-time $(date -d '10 minutes ago' +%s)000
```

### Test Locally

```bash
# Install TypeScript and ts-node globally (optional)
npm install -g ts-node typescript

# Run TypeScript directly
ts-node lambda/sign_in/index.ts
```

### Invoke Lambda

```bash
# Test with AWS CLI
aws lambda invoke \
  --function-name riftbound-dev-sign-in \
  --payload '{"body":"{\"email\":\"test@example.com\",\"password\":\"TestPass123!\"}"}' \
  response.json

cat response.json
```

## Dependencies

Each Lambda function depends on:
- `aws-sdk` - AWS SDK for Node.js (for Cognito)

No other external dependencies to keep Lambda package size small.

## Best Practices

1. **Keep functions lean** - Lambda charges per 100ms
2. **Cache SDK clients** - Initialize outside handler
3. **Use environment variables** - For configuration
4. **Handle errors gracefully** - Return proper HTTP status codes
5. **Log everything** - Use `console.log()` for debugging
6. **Type everything** - Use TypeScript interfaces

## File Structure

```
lambda/
├── sign_in/
│   ├── index.ts          ← Source code
│   ├── tsconfig.json     ← TypeScript config
│   └── package.json      ← Dependencies
├── sign_up/
│   ├── index.ts
│   ├── tsconfig.json
│   └── package.json
├── refresh_token/
│   ├── index.ts
│   ├── tsconfig.json
│   └── package.json
├── build.sh              ← Build all functions
└── .gitignore            ← Git ignore rules
```

## Next Steps

1. **Build functions**: `bash lambda/build.sh`
2. **Deploy infrastructure**: `cd cdk && ./deploy.sh`
3. **Test endpoints**: See `QUICKSTART.md`
4. **Monitor logs**: `aws logs tail /aws/lambda/...`

## Resources

- [AWS Lambda Documentation](https://docs.aws.amazon.com/lambda/)
- [AWS SDK for JavaScript](https://docs.aws.amazon.com/sdk-for-javascript/)
- [Cognito Documentation](https://docs.aws.amazon.com/cognito/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
