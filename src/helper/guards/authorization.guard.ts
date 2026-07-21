/* eslint-disable prettier/prettier */
import { Injectable, CanActivate, Inject, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Cache } from "cache-manager";
import { jwtDecode } from 'jwt-decode';

@Injectable()
export class AuthorizationGuard implements CanActivate {

    constructor(
        private readonly reflector: Reflector,
        @Inject('CACHE_MANAGER') private Cache: Cache
    ) {}
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride('isPublic', [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) return true

        let request = context.switchToHttp().getRequest()
        let token = request.headers['authorization'] || request.headers['Authorization'];
        token = (token && typeof token === 'string' && token.startsWith('Bearer ')) ? token.substring(7).trim() : null;

        if (!token || typeof token !== 'string') {
            throw new UnauthorizedException('Unauthorized access')
        }

        try{
            let decode_token: any = jwtDecode(token)
            console.log('Decoded token in guard', decode_token)
            if (!(Object.keys(decode_token).length > 0)) throw new UnauthorizedException('Unauthorized access')
            let all_users: any[] = (await this.Cache.get('all_users')) || []
            let profile = all_users.find((obj:any)=>obj.id === decode_token?.sub) ||null 
            request['user'] = 
                {
                    id: decode_token.sub,
                    profile
                }
        }
        catch(err){
            throw new UnauthorizedException('Unauthorized access')
        }
        return true
    }
}